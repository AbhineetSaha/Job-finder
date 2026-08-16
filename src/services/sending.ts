/**
 * The send pipeline. This is where every safety rule is enforced for real.
 *
 * Structure of one send:
 *   1. transaction: lock the message row, re-read every input from the
 *      database, build a complete SendPreflightSnapshot, evaluate it, and —
 *      only if it passes — claim an attempt row and mark the message SENDING.
 *   2. outside the transaction: call the provider. A network call is never
 *      made while holding locks.
 *   3. transaction: record the outcome.
 *
 * Crash between 2 and 3 leaves a STARTED attempt row. The recovery path reuses
 * that same attempt number, so the idempotency key handed to the provider is
 * identical and the provider deduplicates rather than delivering twice.
 */
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  campaignMembers,
  campaigns,
  companies,
  contacts,
  messageApprovals,
  messageAttempts,
  messages,
  prospects,
  replies,
  sendLedger,
  settings,
  userProfiles,
  type Message,
} from '../db/schema.js';
import {
  evaluateSendPreflight,
  isTransientBlock,
  type BlockReason,
  type SendPreflightSnapshot,
} from '../domain/safety.js';
import { checkRateLimits } from '../domain/ratelimit.js';
import { isWithinSendingWindow, type WindowConfig } from '../domain/window.js';
import { startOfLocalDay } from '../domain/timezone.js';
import { emailDomain, isValidEmailShape } from '../domain/normalize.js';
import { statusAfterSend, type ProspectStatus } from '../domain/status.js';
import { contentHash, idempotencyKey } from '../lib/crypto.js';
import { getEnv } from '../lib/env.js';
import { incrementMetric, logger } from '../lib/logger.js';
import { getEmailProvider } from '../email/index.js';
import { checkSuppression } from './suppression.js';
import { resolveConfig } from './config.js';
import { recordActivity, recordAudit } from './audit.js';

export type SendOutcome =
  | { status: 'SENT'; providerMessageId: string }
  | { status: 'BLOCKED'; reason: BlockReason; detail: string; transient: boolean; retryAfter: Date | null }
  | { status: 'FAILED'; permanent: boolean; errorCode: string; errorMessage: string };

interface PreparedSend {
  message: Message;
  attemptId: string;
  attemptNumber: number;
  key: string;
  fromEmail: string;
  replyTo: string | undefined;
  recipientDomain: string;
}

/**
 * Assemble the complete preflight snapshot. Every field is read here; nothing
 * is inferred and nothing is defaulted. If a value cannot be determined the
 * field is left undefined, and `evaluateSendPreflight` blocks the send.
 */
async function buildSnapshot(
  tx: Database,
  message: Message,
  now: Date,
): Promise<Partial<SendPreflightSnapshot>> {
  const settingsRows = await tx
    .select()
    .from(settings)
    .where(eq(settings.userId, message.userId))
    .limit(1);
  const settingsRow = settingsRows[0];
  if (!settingsRow) return {}; // no config → SNAPSHOT_INCOMPLETE → no send
  const config = resolveConfig(settingsRow);

  const prospectRows = await tx
    .select({ prospect: prospects, contact: contacts, company: companies })
    .from(prospects)
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .where(eq(prospects.id, message.prospectId))
    .limit(1);
  const row = prospectRows[0];

  if (!row) {
    return {
      globalSendPaused: config.globalSendPaused,
      prospectExists: false,
      prospectStatus: 'INVALID' as ProspectStatus,
      recipientEmail: message.toEmail,
      recipientEmailValid: false,
      recipientSuppressed: true,
      recipientDomainSuppressed: false,
      messageStatus: message.status,
      currentContentHash: message.contentHash,
      approvalExists: false,
      approvalRevoked: false,
      approvedContentHash: null,
      alreadySentForStep: false,
      alreadyDispatched: false,
      campaignStatus: null,
      campaignMemberStatus: null,
      hasReply: false,
      windowAllowed: false,
      windowDetail: 'Prospect missing.',
      rateLimitAllowed: false,
      rateLimitDetail: 'Prospect missing.',
      postalAddressConfigured: false,
      providerConfigured: false,
      scheduledAt: message.scheduledAt,
      now,
    };
  }

  const suppression = await checkSuppression(message.userId, message.toEmail, tx);

  const approvalRows = await tx
    .select()
    .from(messageApprovals)
    .where(eq(messageApprovals.messageId, message.id))
    .orderBy(desc(messageApprovals.approvalVersion))
    .limit(1);
  const approval = approvalRows[0];

  // A reply from this contact stops the sequence regardless of when it arrived.
  const replyRows = await tx
    .select({ id: replies.id })
    .from(replies)
    .where(eq(replies.contactId, message.contactId))
    .limit(1);

  const dispatched = await tx
    .select({ id: messageAttempts.id })
    .from(messageAttempts)
    .where(and(eq(messageAttempts.messageId, message.id), eq(messageAttempts.status, 'SUCCEEDED')))
    .limit(1);

  // Another message for the same sequence step that already went out.
  let alreadySentForStep = false;
  if (message.campaignMemberId && message.campaignStepId) {
    const sibling = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.campaignMemberId, message.campaignMemberId),
          eq(messages.campaignStepId, message.campaignStepId),
          sql`${messages.id} <> ${message.id}`,
          sql`${messages.status} in ('SENT','DELIVERED','SENDING')`,
        ),
      )
      .limit(1);
    alreadySentForStep = sibling.length > 0;
  }

  let campaignStatus: string | null = null;
  let campaignMemberStatus: string | null = null;
  let windowConfig: WindowConfig | null = null;

  if (message.campaignMemberId) {
    const memberRows = await tx
      .select({ member: campaignMembers, campaign: campaigns })
      .from(campaignMembers)
      .innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
      .where(eq(campaignMembers.id, message.campaignMemberId))
      .limit(1);

    const memberRow = memberRows[0];
    if (!memberRow) {
      // The enrolment vanished mid-flight. Return a deliberately incomplete
      // snapshot so the preflight blocks with SNAPSHOT_INCOMPLETE rather than
      // silently degrading to "this is a one-off message with no campaign".
      return { now };
    }
    campaignStatus = memberRow.campaign.status;
    campaignMemberStatus = memberRow.member.status;
    windowConfig = {
      windows: memberRow.campaign.sendingWindows,
      sendDays: memberRow.campaign.sendDays,
      // Prospect timezone wins when known; campaign default otherwise (brief §28).
      timeZone: row.contact.timezone ?? row.company.timezone ?? memberRow.campaign.timezone,
    };
  } else {
    // A one-off message still respects a sensible window rather than none.
    windowConfig = {
      windows: [{ start: '09:00', end: '17:00' }],
      sendDays: [1, 2, 3, 4, 5],
      timeZone: row.contact.timezone ?? row.company.timezone ?? config.defaultTimezone,
    };
  }

  const window = isWithinSendingWindow(now, windowConfig);

  const dayStart = startOfLocalDay(now, windowConfig.timeZone);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const domain = emailDomain(message.toEmail) ?? '';

  // Sequential, not Promise.all: these share one transaction client, and pg
  // does not support concurrent queries on a single client.
  const todayRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sendLedger)
    .where(and(eq(sendLedger.userId, message.userId), gte(sendLedger.sentAt, dayStart)));

  const hourRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sendLedger)
    .where(and(eq(sendLedger.userId, message.userId), gte(sendLedger.sentAt, hourAgo)));

  const domainRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sendLedger)
    .where(
      and(
        eq(sendLedger.userId, message.userId),
        eq(sendLedger.recipientDomain, domain),
        gte(sendLedger.sentAt, dayStart),
      ),
    );

  const lastRows = await tx
    .select({ sentAt: sendLedger.sentAt })
    .from(sendLedger)
    .where(eq(sendLedger.userId, message.userId))
    .orderBy(desc(sendLedger.sentAt))
    .limit(1);

  const rateLimit = checkRateLimits(
    config.rateLimits,
    {
      sentToday: todayRows[0]?.count ?? 0,
      sentLastHour: hourRows[0]?.count ?? 0,
      sentToDomainToday: domainRows[0]?.count ?? 0,
      lastSentAt: lastRows[0]?.sentAt ?? null,
    },
    now,
  );

  const provider = getEmailProvider();

  // A missing sender identity is a configuration gap, and must surface as a
  // blocked send with a clear reason rather than as an opaque provider error.
  const profileRows = await tx
    .select({ email: userProfiles.email })
    .from(userProfiles)
    .where(eq(userProfiles.userId, message.userId))
    .limit(1);
  const fromAddress = message.fromEmail ?? getEnv().EMAIL_FROM ?? profileRows[0]?.email ?? '';

  return {
    globalSendPaused: config.globalSendPaused,
    prospectExists: true,
    prospectStatus: row.prospect.status as ProspectStatus,
    recipientEmail: message.toEmail,
    recipientEmailValid: isValidEmailShape(message.toEmail),
    recipientSuppressed: suppression.emailSuppressed,
    recipientDomainSuppressed: suppression.domainSuppressed,
    messageStatus: message.status,
    // Recomputed from current content, not read from the column: an edit that
    // somehow bypassed editDraft still invalidates the approval.
    currentContentHash: contentHash(message.toEmail, message.subject, message.bodyText),
    approvalExists: Boolean(approval),
    approvalRevoked: Boolean(approval?.revokedAt),
    approvedContentHash: approval?.contentHash ?? null,
    alreadySentForStep,
    alreadyDispatched: dispatched.length > 0,
    campaignStatus,
    campaignMemberStatus,
    hasReply: replyRows.length > 0,
    windowAllowed: window.allowed,
    windowDetail: window.detail,
    rateLimitAllowed: rateLimit.allowed,
    rateLimitDetail: rateLimit.detail,
    postalAddressConfigured: config.postalAddress.trim().length > 0,
    providerConfigured: provider.isConfigured() && fromAddress.trim().length > 0,
    scheduledAt: message.scheduledAt,
    now,
  };
}

/**
 * Phase 1: validate and claim. Returns either a prepared send or the reason it
 * was blocked. Never performs network I/O.
 */
async function prepareSend(
  messageId: string,
  now: Date,
): Promise<{ ok: true; prepared: PreparedSend } | { ok: false; outcome: SendOutcome }> {
  return getDb().transaction(async (tx) => {
    // Row lock: two workers cannot prepare the same message concurrently.
    // Uses the query builder rather than raw SQL so the result is mapped to
    // camelCase field names — a raw `select *` returns snake_case columns.
    const locked = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .for('update');
    const message = locked[0];

    if (!message) {
      return {
        ok: false as const,
        outcome: {
          status: 'BLOCKED' as const,
          reason: 'PROSPECT_MISSING' as BlockReason,
          detail: 'Message not found.',
          transient: false,
          retryAfter: null,
        },
      };
    }

    const snapshot = await buildSnapshot(tx, message, now);
    const verdict = evaluateSendPreflight(snapshot);

    if (!verdict.ok) {
      const transient = isTransientBlock(verdict.reason);

      // A message that simply is not approved yet must keep its review status:
      // marking it BLOCKED would silently drop it out of the operator's review
      // queue, turning "you haven't approved this" into "this disappeared".
      const awaitingReview = message.status === 'DRAFT' || message.status === 'PENDING_APPROVAL';

      await tx
        .update(messages)
        .set({
          blockedReason: `${verdict.reason}: ${verdict.detail}`,
          updatedAt: new Date(),
          // A permanent block ends the message; a transient one leaves it queued.
          ...(transient || awaitingReview ? {} : { status: 'BLOCKED' as const }),
        })
        .where(eq(messages.id, message.id));

      await recordAudit(
        {
          userId: message.userId,
          actorType: 'SYSTEM',
          action: 'EMAIL_BLOCKED',
          entityType: 'message',
          entityId: message.id,
          metadata: { reason: verdict.reason, detail: verdict.detail, transient },
        },
        tx,
      );

      if (!transient) {
        await recordActivity(
          {
            userId: message.userId,
            prospectId: message.prospectId,
            type: 'EMAIL_BLOCKED',
            title: `Send blocked: ${verdict.reason}`,
            body: verdict.detail,
            metadata: { messageId: message.id },
          },
          tx,
        );
      }

      incrementMetric('emails_blocked');

      return {
        ok: false as const,
        outcome: {
          status: 'BLOCKED' as const,
          reason: verdict.reason,
          detail: verdict.detail,
          transient,
          retryAfter: null,
        },
      };
    }

    // Reuse an in-flight attempt so a crash-recovery retry presents the same
    // idempotency key to the provider instead of minting a new one.
    const inFlight = await tx
      .select()
      .from(messageAttempts)
      .where(and(eq(messageAttempts.messageId, message.id), eq(messageAttempts.status, 'STARTED')))
      .orderBy(desc(messageAttempts.attemptNumber))
      .limit(1);

    let attemptId: string;
    let attemptNumber: number;
    let key: string;

    if (inFlight[0]) {
      attemptId = inFlight[0].id;
      attemptNumber = inFlight[0].attemptNumber;
      key = inFlight[0].idempotencyKey;
      logger.warn('Resuming an in-flight send attempt', {
        event: 'send_attempt_resumed',
        messageId: message.id,
        attempt: attemptNumber,
      });
    } else {
      const previous = await tx
        .select({ n: messageAttempts.attemptNumber })
        .from(messageAttempts)
        .where(eq(messageAttempts.messageId, message.id))
        .orderBy(desc(messageAttempts.attemptNumber))
        .limit(1);

      attemptNumber = (previous[0]?.n ?? 0) + 1;
      key = idempotencyKey(message.id, attemptNumber);

      const provider = getEmailProvider();
      const inserted = await tx
        .insert(messageAttempts)
        .values({
          messageId: message.id,
          attemptNumber,
          idempotencyKey: key,
          status: 'STARTED',
          provider: provider.name,
        })
        .returning({ id: messageAttempts.id });

      const created = inserted[0];
      if (!created) {
        return {
          ok: false as const,
          outcome: {
            status: 'FAILED' as const,
            permanent: false,
            errorCode: 'ATTEMPT_INSERT_FAILED',
            errorMessage: 'Could not claim a send attempt.',
          },
        };
      }
      attemptId = created.id;
    }

    await tx
      .update(messages)
      .set({ status: 'SENDING', updatedAt: new Date(), blockedReason: null })
      .where(eq(messages.id, message.id));

    const env = getEnv();
    const profileRows = await tx
      .select({ email: userProfiles.email })
      .from(userProfiles)
      .where(eq(userProfiles.userId, message.userId))
      .limit(1);

    return {
      ok: true as const,
      prepared: {
        message,
        attemptId,
        attemptNumber,
        key,
        fromEmail: message.fromEmail ?? env.EMAIL_FROM ?? profileRows[0]?.email ?? '',
        replyTo: env.EMAIL_REPLY_TO,
        recipientDomain: emailDomain(message.toEmail) ?? '',
      },
    };
  });
}

/** Phase 3: record the outcome of a successful provider call. */
async function recordSuccess(prepared: PreparedSend, providerMessageId: string): Promise<void> {
  const { message } = prepared;

  await getDb().transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(messageAttempts)
      .set({ status: 'SUCCEEDED', providerMessageId, finishedAt: now })
      .where(eq(messageAttempts.id, prepared.attemptId));

    await tx
      .update(messages)
      .set({ status: 'SENT', sentAt: now, providerMessageId, updatedAt: now })
      .where(eq(messages.id, message.id));

    // Narrow ledger row: this is what rate limiting counts.
    await tx.insert(sendLedger).values({
      userId: message.userId,
      messageId: message.id,
      recipientDomain: prepared.recipientDomain,
      sentAt: now,
    });

    let position = 0;
    if (message.campaignMemberId) {
      const memberRows = await tx
        .select()
        .from(campaignMembers)
        .where(eq(campaignMembers.id, message.campaignMemberId))
        .limit(1);
      const member = memberRows[0];
      if (member) {
        position = member.currentPosition;
        await tx
          .update(campaignMembers)
          .set({ currentPosition: member.currentPosition + 1, updatedAt: now })
          .where(eq(campaignMembers.id, member.id));
      }
    }

    const nextStatus = statusAfterSend(position);
    const prospectRows = await tx
      .select({ status: prospects.status })
      .from(prospects)
      .where(eq(prospects.id, message.prospectId))
      .limit(1);

    const currentStatus = prospectRows[0]?.status as ProspectStatus | undefined;
    // Only advance forward through the contacted statuses; never rewind a
    // prospect that has already replied or booked a meeting.
    const advanceable: ProspectStatus[] = ['APPROVED', 'CONTACTED', 'FOLLOW_UP_1', 'READY_FOR_REVIEW', 'QUALIFIED'];

    await tx
      .update(prospects)
      .set({
        lastContactedAt: now,
        updatedAt: now,
        ...(currentStatus && advanceable.includes(currentStatus)
          ? { status: nextStatus, statusChangedAt: now }
          : {}),
      })
      .where(eq(prospects.id, message.prospectId));

    await recordActivity(
      {
        userId: message.userId,
        prospectId: message.prospectId,
        type: 'EMAIL_SENT',
        title: `Email sent: ${message.subject}`,
        body: `To ${message.toEmail}`,
        occurredAt: now,
        metadata: { messageId: message.id, providerMessageId, position },
      },
      tx,
    );

    await recordAudit(
      {
        userId: message.userId,
        actorType: 'SYSTEM',
        action: 'EMAIL_SENT',
        entityType: 'message',
        entityId: message.id,
        metadata: {
          providerMessageId,
          to: message.toEmail,
          attempt: prepared.attemptNumber,
        },
      },
      tx,
    );
  });

  incrementMetric('emails_sent');
  logger.info('Email sent', {
    event: 'email_sent',
    status: 'SENT',
    userId: message.userId,
    prospectId: message.prospectId,
    contactId: message.contactId,
    messageId: message.id,
  });
}

async function recordFailure(
  prepared: PreparedSend,
  failure: { permanent: boolean; errorCode: string; errorMessage: string },
): Promise<void> {
  const { message } = prepared;

  await getDb().transaction(async (tx) => {
    await tx
      .update(messageAttempts)
      .set({
        status: 'FAILED',
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage.slice(0, 2000),
        finishedAt: new Date(),
      })
      .where(eq(messageAttempts.id, prepared.attemptId));

    await tx
      .update(messages)
      .set({
        // A transient failure returns to APPROVED so the queue can retry it;
        // a permanent one ends here.
        status: failure.permanent ? 'FAILED' : 'APPROVED',
        blockedReason: `${failure.errorCode}: ${failure.errorMessage}`.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(messages.id, message.id));

    await recordAudit(
      {
        userId: message.userId,
        actorType: 'SYSTEM',
        action: 'EMAIL_FAILED',
        entityType: 'message',
        entityId: message.id,
        metadata: { ...failure, attempt: prepared.attemptNumber },
      },
      tx,
    );
  });

  incrementMetric('emails_failed');
  incrementMetric('provider_errors');
  logger.error('Email send failed', {
    event: 'email_failed',
    status: 'FAILED',
    userId: message.userId,
    messageId: message.id,
    error: `${failure.errorCode}: ${failure.errorMessage}`,
  });
}

/**
 * Send one message. Safe to call concurrently and safe to retry: the row lock,
 * the attempt ledger, and the preflight duplicate checks each independently
 * prevent a second delivery.
 */
export async function sendMessage(messageId: string, now = new Date()): Promise<SendOutcome> {
  incrementMetric('emails_attempted');

  const preparation = await prepareSend(messageId, now);
  if (!preparation.ok) return preparation.outcome;

  const prepared = preparation.prepared;
  const provider = getEmailProvider();

  const result = await provider.sendEmail({
    to: prepared.message.toEmail,
    from: prepared.fromEmail,
    replyTo: prepared.replyTo,
    subject: prepared.message.subject,
    text: prepared.message.bodyText,
    idempotencyKey: prepared.key,
    headers: {
      // RFC 8058 one-click unsubscribe is extracted from the body footer link.
      'X-Entity-Ref-ID': prepared.message.id,
    },
  });

  if (result.ok) {
    await recordSuccess(prepared, result.providerMessageId);
    return { status: 'SENT', providerMessageId: result.providerMessageId };
  }

  await recordFailure(prepared, result);
  return {
    status: 'FAILED',
    permanent: result.permanent,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}

/** Messages that are approved and due, used by the scheduler to enqueue work. */
export async function findDueMessages(limit = 100): Promise<Message[]> {
  return getDb()
    .select()
    .from(messages)
    .where(
      and(
        sql`${messages.status} in ('APPROVED','SCHEDULED')`,
        sql`(${messages.scheduledAt} is null or ${messages.scheduledAt} <= now())`,
        isNull(messages.sentAt),
      ),
    )
    .orderBy(messages.scheduledAt)
    .limit(limit);
}
