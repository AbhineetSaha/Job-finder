/**
 * Inbound provider events: deliveries, bounces, complaints, and replies.
 *
 * Reply classification is a human action — nothing here infers intent from the
 * text (brief §34). What this module does automatically is only what is
 * unambiguous: a reply stops the sequence, a hard bounce suppresses.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  contacts,
  messages,
  prospects,
  replies,
  webhookEvents,
  type Reply,
} from '../db/schema.js';
import { normalizeEmail } from '../domain/normalize.js';
import { canTransition, type ProspectStatus } from '../domain/status.js';
import type { ProviderEvent } from '../email/provider.js';
import { incrementMetric, logger } from '../lib/logger.js';
import { recordActivity, recordAudit } from './audit.js';
import { stopSequence } from './campaigns.js';
import { addSuppression } from './suppression.js';

export type ReplyClassification =
  | 'UNCLASSIFIED'
  | 'POSITIVE'
  | 'INTERESTED'
  | 'QUESTION'
  | 'NOT_INTERESTED'
  | 'REFERRAL'
  | 'OTHER';

export interface EventProcessResult {
  processed: boolean;
  duplicate: boolean;
  action: string;
}

/**
 * Persist and process one provider event.
 *
 * The `webhook_events` unique index on (provider, provider_event_id) is what
 * makes this idempotent: a replayed webhook inserts nothing and does nothing.
 */
export async function processProviderEvent(
  provider: string,
  event: ProviderEvent,
  signatureVerified: boolean,
): Promise<EventProcessResult> {
  const db = getDb();

  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider,
      providerEventId: event.eventId,
      eventType: event.type,
      payload: event.raw,
      signatureVerified,
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning({ id: webhookEvents.id });

  const eventRow = inserted[0];
  if (!eventRow) {
    logger.info('Duplicate webhook event ignored', {
      event: 'webhook_duplicate',
      status: 'ignored',
    });
    return { processed: false, duplicate: true, action: 'duplicate' };
  }

  // An unverified event is stored for forensics but must never act on data.
  if (!signatureVerified) {
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date(), error: 'Signature not verified; event ignored.' })
      .where(eq(webhookEvents.id, eventRow.id));
    return { processed: false, duplicate: false, action: 'unverified' };
  }

  let action = 'ignored';
  try {
    switch (event.type) {
      case 'delivered':
        action = await handleDelivered(event);
        break;
      case 'bounced':
        action = await handleBounced(event);
        break;
      case 'complained':
        action = await handleComplaint(event);
        break;
      case 'replied':
        action = await handleReply(event);
        break;
      default:
        action = 'unknown_type';
    }

    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.id, eventRow.id));

    return { processed: true, duplicate: false, action };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(webhookEvents.id, eventRow.id));
    logger.error('Webhook processing failed', { event: 'webhook_failed', error: message });
    throw error;
  }
}

async function findMessageByProviderId(providerMessageId: string | null, tx?: Database) {
  if (!providerMessageId) return null;
  const db = tx ?? getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.providerMessageId, providerMessageId))
    .limit(1);
  return rows[0] ?? null;
}

async function handleDelivered(event: ProviderEvent): Promise<string> {
  const message = await findMessageByProviderId(event.providerMessageId);
  if (!message) return 'message_not_found';

  await getDb()
    .update(messages)
    .set({ status: 'DELIVERED', updatedAt: new Date() })
    .where(and(eq(messages.id, message.id), eq(messages.status, 'SENT')));

  await recordAudit({
    userId: message.userId,
    actorType: 'WEBHOOK',
    action: 'EMAIL_DELIVERED',
    entityType: 'message',
    entityId: message.id,
    metadata: { providerMessageId: event.providerMessageId },
  });

  return 'delivered';
}

/**
 * A hard bounce means the address is undeliverable: suppress it, stop the
 * sequence, and mark the prospect BOUNCED. A soft bounce is recorded but does
 * not suppress — a full mailbox is not a permanent condition.
 */
async function handleBounced(event: ProviderEvent): Promise<string> {
  const message = await findMessageByProviderId(event.providerMessageId);
  const recipient = event.recipient ?? message?.toEmail ?? null;
  if (!message || !recipient) return 'message_not_found';

  const permanent = event.permanent !== false;

  await getDb()
    .update(messages)
    .set({ status: 'BOUNCED', updatedAt: new Date() })
    .where(eq(messages.id, message.id));

  await recordActivity({
    userId: message.userId,
    prospectId: message.prospectId,
    type: 'EMAIL_BOUNCED',
    title: permanent ? 'Email hard bounced' : 'Email soft bounced',
    body: recipient,
    metadata: { messageId: message.id, permanent },
  });

  await recordAudit({
    userId: message.userId,
    actorType: 'WEBHOOK',
    action: 'EMAIL_BOUNCED',
    entityType: 'message',
    entityId: message.id,
    metadata: { recipient, permanent },
  });

  incrementMetric('emails_bounced');

  if (!permanent) return 'soft_bounce_recorded';

  // Suppress first, then stop: if the process dies between the two, the
  // suppression alone is enough to prevent another send.
  await addSuppression({
    userId: message.userId,
    email: recipient,
    reason: 'BOUNCED',
    note: `Hard bounce on message ${message.id}.`,
    stopSequences: true,
  });

  await stopSequence(message.userId, message.prospectId, 'BOUNCED', 'Hard bounce received.');
  await setProspectStatus(message.userId, message.prospectId, 'BOUNCED');

  return 'hard_bounce_suppressed';
}

async function handleComplaint(event: ProviderEvent): Promise<string> {
  const message = await findMessageByProviderId(event.providerMessageId);
  const recipient = event.recipient ?? message?.toEmail ?? null;
  if (!message || !recipient) return 'message_not_found';

  // A spam complaint is the strongest possible do-not-contact signal.
  await addSuppression({
    userId: message.userId,
    email: recipient,
    reason: 'DO_NOT_CONTACT',
    note: 'Spam complaint received from the provider.',
    stopSequences: true,
  });

  await stopSequence(message.userId, message.prospectId, 'DO_NOT_CONTACT', 'Spam complaint.');
  await setProspectStatus(message.userId, message.prospectId, 'DO_NOT_CONTACT');

  return 'complaint_suppressed';
}

/**
 * A reply stops the sequence unconditionally. Identification is by the
 * outbound message id when the provider supplies it, and by normalised sender
 * address otherwise.
 */
async function handleReply(event: ProviderEvent): Promise<string> {
  const fromEmail = normalizeEmail(event.fromEmail ?? event.recipient);
  if (!fromEmail) return 'sender_not_identified';

  const db = getDb();
  const original = await findMessageByProviderId(event.providerMessageId);

  const contactRows = original
    ? await db.select().from(contacts).where(eq(contacts.id, original.contactId)).limit(1)
    : await db.select().from(contacts).where(eq(contacts.normalizedEmail, fromEmail)).limit(1);

  const contact = contactRows[0];
  if (!contact) return 'contact_not_found';

  const prospectRows = await db
    .select()
    .from(prospects)
    .where(eq(prospects.contactId, contact.id))
    .limit(1);
  const prospect = prospectRows[0];
  if (!prospect) return 'prospect_not_found';

  await db.transaction(async (tx) => {
    await tx.insert(replies).values({
      userId: prospect.userId,
      prospectId: prospect.id,
      contactId: contact.id,
      messageId: original?.id ?? null,
      providerMessageId: event.providerMessageId,
      fromEmail: event.fromEmail ?? contact.email,
      subject: event.subject ?? null,
      bodyText: event.bodyText ?? null,
      receivedAt: event.occurredAt,
      classification: 'UNCLASSIFIED',
    });

    await recordActivity(
      {
        userId: prospect.userId,
        prospectId: prospect.id,
        type: 'REPLY_RECEIVED',
        title: `Reply received from ${contact.fullName}`,
        body: event.subject ?? null,
        occurredAt: event.occurredAt,
        metadata: { messageId: original?.id ?? null },
      },
      tx,
    );

    await recordAudit(
      {
        userId: prospect.userId,
        actorType: 'WEBHOOK',
        action: 'REPLY_RECEIVED',
        entityType: 'prospect',
        entityId: prospect.id,
        metadata: { contactId: contact.id, messageId: original?.id ?? null },
      },
      tx,
    );

    await stopSequence(prospect.userId, prospect.id, 'REPLY_RECEIVED', 'Contact replied.', tx);
  });

  await setProspectStatus(prospect.userId, prospect.id, 'REPLIED');

  incrementMetric('replies');
  logger.info('Reply received', {
    event: 'reply_received',
    userId: prospect.userId,
    prospectId: prospect.id,
    contactId: contact.id,
  });

  return 'reply_recorded';
}

/** Best-effort status advance that respects the state machine. */
async function setProspectStatus(
  userId: string,
  prospectId: string,
  to: ProspectStatus,
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ status: prospects.status })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
    .limit(1);

  const current = rows[0]?.status as ProspectStatus | undefined;
  if (!current) return;
  if (!canTransition(current, to).allowed) return;

  await db
    .update(prospects)
    .set({ status: to, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(prospects.id, prospectId));

  await recordActivity({
    userId,
    prospectId,
    type: 'STATUS_CHANGED',
    title: `Status: ${current} → ${to}`,
    metadata: { from: current, to, automatic: true },
  });
}

/* -------------------------------------------------------------------------- */
/* Manual reply handling                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Record a reply the operator received in their own inbox. Cold outreach from
 * a personal domain usually replies to the inbox directly rather than through
 * a provider webhook, so this is the common path, not the fallback.
 */
export async function recordManualReply(input: {
  userId: string;
  prospectId: string;
  fromEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  receivedAt?: Date;
  classification?: ReplyClassification;
}): Promise<{ ok: true; reply: Reply } | { ok: false; error: string }> {
  const db = getDb();

  const rows = await db
    .select({ prospect: prospects, contact: contacts })
    .from(prospects)
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(and(eq(prospects.id, input.prospectId), eq(prospects.userId, input.userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, error: 'Prospect not found.' };

  const lastOutbound = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.prospectId, input.prospectId), eq(messages.direction, 'OUTBOUND')))
    .orderBy(desc(messages.sentAt))
    .limit(1);

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(replies)
      .values({
        userId: input.userId,
        prospectId: input.prospectId,
        contactId: row.contact.id,
        messageId: lastOutbound[0]?.id ?? null,
        fromEmail: input.fromEmail ?? row.contact.email,
        subject: input.subject ?? null,
        bodyText: input.bodyText ?? null,
        receivedAt: input.receivedAt ?? new Date(),
        classification: input.classification ?? 'UNCLASSIFIED',
        ...(input.classification && input.classification !== 'UNCLASSIFIED'
          ? { classifiedBy: input.userId, classifiedAt: new Date() }
          : {}),
      })
      .returning();

    const reply = inserted[0];
    if (!reply) throw new Error('Could not record the reply.');

    await recordActivity(
      {
        userId: input.userId,
        prospectId: input.prospectId,
        type: 'REPLY_RECEIVED',
        title: 'Reply logged manually',
        body: input.subject ?? null,
        occurredAt: reply.receivedAt,
      },
      tx,
    );

    await recordAudit(
      {
        userId: input.userId,
        action: 'REPLY_RECEIVED',
        entityType: 'reply',
        entityId: reply.id,
        metadata: { prospectId: input.prospectId, manual: true },
      },
      tx,
    );

    await stopSequence(input.userId, input.prospectId, 'REPLY_RECEIVED', 'Reply logged.', tx);

    return reply;
  });

  await setProspectStatus(input.userId, input.prospectId, 'REPLIED');
  incrementMetric('replies');

  return { ok: true, reply: result };
}

/** Human classification of a reply. The only way a reply gets classified. */
export async function classifyReply(
  userId: string,
  replyId: string,
  classification: ReplyClassification,
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();

  const rows = await db
    .select()
    .from(replies)
    .where(and(eq(replies.id, replyId), eq(replies.userId, userId)))
    .limit(1);

  const reply = rows[0];
  if (!reply) return { ok: false, error: 'Reply not found.' };

  await db
    .update(replies)
    .set({ classification, classifiedBy: userId, classifiedAt: new Date(), readAt: new Date() })
    .where(eq(replies.id, replyId));

  await recordAudit({
    userId,
    action: 'REPLY_CLASSIFIED',
    entityType: 'reply',
    entityId: replyId,
    metadata: { classification, prospectId: reply.prospectId },
  });

  // A negative reply is an explicit do-not-contact request.
  if (classification === 'NOT_INTERESTED') {
    await setProspectStatus(userId, reply.prospectId, 'NOT_INTERESTED');
    await stopSequence(userId, reply.prospectId, 'NOT_INTERESTED', 'Reply classified as not interested.');
  }

  return { ok: true };
}

export async function listUnreadReplies(userId: string, limit = 50) {
  return getDb()
    .select({ reply: replies, prospect: prospects, contact: contacts })
    .from(replies)
    .innerJoin(prospects, eq(prospects.id, replies.prospectId))
    .innerJoin(contacts, eq(contacts.id, replies.contactId))
    .where(and(eq(replies.userId, userId), isNull(replies.readAt)))
    .orderBy(desc(replies.receivedAt))
    .limit(limit);
}

export async function countUnreadReplies(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(replies)
    .where(and(eq(replies.userId, userId), isNull(replies.readAt)));
  return rows[0]?.count ?? 0;
}

/**
 * Honour an unsubscribe. Synchronous and immediate: the suppression, the
 * sequence stop, and the status change all commit before the response.
 */
export async function processUnsubscribe(
  tokenHash: string,
): Promise<{ ok: boolean; alreadyDone?: boolean; error?: string }> {
  const db = getDb();
  const { unsubscribeTokens } = await import('../db/schema.js');

  const rows = await db
    .select()
    .from(unsubscribeTokens)
    .where(eq(unsubscribeTokens.tokenHash, tokenHash))
    .limit(1);

  const token = rows[0];
  if (!token) return { ok: false, error: 'This unsubscribe link is not valid.' };

  const contactRows = await db.select().from(contacts).where(eq(contacts.id, token.contactId)).limit(1);
  const contact = contactRows[0];
  if (!contact) return { ok: false, error: 'Contact not found.' };

  // Tokens do not expire and remain usable after first use: CAN-SPAM requires
  // the mechanism to keep working, and re-confirming must never appear to fail.
  const alreadyDone = Boolean(token.usedAt);

  await addSuppression({
    userId: contact.userId,
    email: contact.email,
    reason: 'UNSUBSCRIBED',
    note: 'Unsubscribed via one-click link.',
    stopSequences: true,
  });

  await db
    .update(unsubscribeTokens)
    .set({ usedAt: token.usedAt ?? new Date() })
    .where(eq(unsubscribeTokens.id, token.id));

  const prospectRows = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(eq(prospects.contactId, contact.id))
    .limit(1);

  if (prospectRows[0]) {
    await stopSequence(contact.userId, prospectRows[0].id, 'DO_NOT_CONTACT', 'Unsubscribed.');
    await setProspectStatus(contact.userId, prospectRows[0].id, 'DO_NOT_CONTACT');
  }

  logger.info('Unsubscribe processed', {
    event: 'unsubscribe',
    userId: contact.userId,
    contactId: contact.id,
    status: alreadyDone ? 'already_unsubscribed' : 'unsubscribed',
  });

  return { ok: true, alreadyDone };
}
