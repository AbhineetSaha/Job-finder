/**
 * Email drafting and the human approval gate.
 *
 * The invariant (brief §21): no cold email may be sent unless it went
 * draft → human approval → send, and the approval must still match the exact
 * content being sent. Editing after approval revokes the approval; there is no
 * path that skips this.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  campaignMembers,
  campaigns,
  companies,
  contacts,
  messageApprovals,
  messages,
  prospects,
  services,
  templates,
  unsubscribeTokens,
  userProfiles,
  type Message,
} from '../db/schema.js';
import { appendComplianceFooter, renderEmail, type RenderFailure } from '../domain/template.js';
import { contentHash, generateToken, sha256 } from '../lib/crypto.js';
import { getEnv } from '../lib/env.js';
import { recordActivity, recordAudit } from './audit.js';
import { getConfig } from './config.js';
import { checkSuppression } from './suppression.js';

/** Operator-entered personalisation. Nothing here is generated (brief §19). */
export interface PersonalizationInput {
  specificObservation?: string | null;
  engineeringSignal?: string | null;
  painPoint?: string | null;
  whyRelevant?: string | null;
  specificOffer?: string | null;
  relevantTechnology?: string | null;
}

export interface CreateDraftInput {
  userId: string;
  prospectId: string;
  templateId: string;
  serviceId?: string | null;
  personalization: PersonalizationInput;
  campaignMemberId?: string | null;
  campaignStepId?: string | null;
  scheduledAt?: Date | null;
}

export type CreateDraftResult =
  | { ok: true; message: Message }
  | { ok: false; error: string; renderError?: RenderFailure };

/**
 * Build the variable map from stored records plus the operator's manual
 * personalisation. Values are never invented: an absent field stays absent and
 * the render fails loudly if the template needs it.
 */
async function buildVariables(
  tx: Database,
  userId: string,
  prospectId: string,
  serviceId: string | null,
  personalization: PersonalizationInput,
): Promise<{ ok: true; values: Record<string, string>; recipient: string; contactId: string } | { ok: false; error: string }> {
  const rows = await tx
    .select({ prospect: prospects, company: companies, contact: contacts })
    .from(prospects)
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, error: 'Prospect not found.' };

  const profileRows = await tx
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const profile = profileRows[0];

  let serviceName: string | null = null;
  const effectiveServiceId = serviceId ?? row.prospect.serviceId;
  if (effectiveServiceId) {
    const serviceRows = await tx
      .select({ name: services.name })
      .from(services)
      .where(and(eq(services.id, effectiveServiceId), eq(services.userId, userId)))
      .limit(1);
    serviceName = serviceRows[0]?.name ?? null;
  }

  const values: Record<string, string> = {};
  const assign = (key: string, value: string | null | undefined) => {
    if (value && value.trim()) values[key] = value.trim();
  };

  assign('first_name', row.contact.firstName);
  assign('last_name', row.contact.lastName);
  assign('full_name', row.contact.fullName);
  assign('contact_role', row.contact.role);
  assign('company_name', row.company.name);
  assign('company_description', row.company.description);
  assign('relevant_service', serviceName);
  assign('relevant_technology', personalization.relevantTechnology);
  assign('specific_observation', personalization.specificObservation);
  assign('engineering_signal', personalization.engineeringSignal);
  assign('pain_point', personalization.painPoint);
  assign('why_relevant', personalization.whyRelevant);
  assign('specific_offer', personalization.specificOffer);
  assign('sender_name', profile?.name);
  assign('sender_title', profile?.title);
  assign('sender_email', profile?.email);
  assign('portfolio_url', profile?.portfolioUrl);

  return { ok: true, values, recipient: row.contact.email, contactId: row.contact.id };
}

/** Mint a one-click unsubscribe URL. Only the hash is stored. */
async function createUnsubscribeUrl(tx: Database, userId: string, contactId: string): Promise<string> {
  const token = generateToken(32);
  await tx.insert(unsubscribeTokens).values({ userId, contactId, tokenHash: sha256(token) });
  return `${getEnv().APP_URL.replace(/\/$/, '')}/unsubscribe/${token}`;
}

export async function createDraft(
  input: CreateDraftInput,
  existingTx?: Database,
): Promise<CreateDraftResult> {
  const config = await getConfig(input.userId);

  const run = async (tx: Database): Promise<CreateDraftResult> => {
    const templateRows = await tx
      .select()
      .from(templates)
      .where(and(eq(templates.id, input.templateId), eq(templates.userId, input.userId)))
      .limit(1);

    const template = templateRows[0];
    if (!template) return { ok: false, error: 'Template not found.' };

    const built = await buildVariables(
      tx,
      input.userId,
      input.prospectId,
      input.serviceId ?? null,
      input.personalization,
    );
    if (!built.ok) return { ok: false, error: built.error };

    // Refuse to draft to a suppressed address at all — not merely at send time.
    const suppression = await checkSuppression(input.userId, built.recipient, tx);
    if (suppression.emailSuppressed || suppression.domainSuppressed) {
      return {
        ok: false,
        error: `Cannot draft to ${built.recipient}: ${suppression.detail ?? 'address is suppressed'}.`,
      };
    }

    const rendered = renderEmail(template.subjectTemplate, template.bodyTemplate, built.values);
    if (!rendered.ok) {
      return {
        ok: false,
        error: rendered.error.message,
        renderError: rendered.error,
      };
    }

    const profileRows = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, input.userId))
      .limit(1);
    const profile = profileRows[0];

    const unsubscribeUrl = await createUnsubscribeUrl(tx, input.userId, built.contactId);

    const body = appendComplianceFooter(rendered.email.body, {
      senderName: profile?.name || 'Sender name not configured',
      senderEmail: profile?.email || getEnv().EMAIL_FROM || 'sender email not configured',
      postalAddress: config.postalAddress || '[No postal address configured — required before sending]',
      unsubscribeUrl,
      advertisingDisclosure: config.advertisingDisclosure,
      customFooter: config.unsubscribeFooter,
    });

    const hash = contentHash(built.recipient, rendered.email.subject, body);

    const inserted = await tx
      .insert(messages)
      .values({
        userId: input.userId,
        prospectId: input.prospectId,
        contactId: built.contactId,
        campaignMemberId: input.campaignMemberId ?? null,
        campaignStepId: input.campaignStepId ?? null,
        templateId: template.id,
        direction: 'OUTBOUND',
        toEmail: built.recipient,
        fromEmail: getEnv().EMAIL_FROM ?? null,
        subject: rendered.email.subject,
        bodyText: body,
        variables: rendered.email.used,
        status: 'PENDING_APPROVAL',
        contentHash: hash,
        scheduledAt: input.scheduledAt ?? null,
      })
      .returning();

    const message = inserted[0];
    if (!message) return { ok: false, error: 'Could not create the draft.' };

    await recordActivity(
      {
        userId: input.userId,
        prospectId: input.prospectId,
        type: 'EMAIL_DRAFTED',
        title: `Draft created: ${message.subject}`,
        metadata: { messageId: message.id, templateId: template.id },
      },
      tx,
    );

    await recordAudit(
      {
        userId: input.userId,
        action: 'EMAIL_DRAFT_CREATED',
        entityType: 'message',
        entityId: message.id,
        metadata: { prospectId: input.prospectId, templateId: template.id },
      },
      tx,
    );

    return { ok: true, message };
  };

  return existingTx ? run(existingTx) : getDb().transaction(run);
}

/**
 * Edit a draft. Any change to recipient, subject, or body changes the content
 * hash, which revokes the current approval and returns the message to
 * PENDING_APPROVAL. This is the mechanism that makes "approval must be current"
 * true rather than aspirational.
 */
export async function editDraft(
  userId: string,
  messageId: string,
  changes: { subject?: string; bodyText?: string },
): Promise<{ ok: boolean; error?: string; approvalRevoked?: boolean }> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);

    const message = rows[0];
    if (!message) return { ok: false, error: 'Message not found.' };

    if (['SENT', 'DELIVERED', 'SENDING', 'BOUNCED'].includes(message.status)) {
      return { ok: false, error: `A message that is ${message.status} can no longer be edited.` };
    }

    const subject = changes.subject?.trim() ?? message.subject;
    const bodyText = changes.bodyText ?? message.bodyText;

    if (/[\r\n]/.test(subject)) return { ok: false, error: 'Subject must not contain line breaks.' };
    if (!subject) return { ok: false, error: 'Subject must not be empty.' };
    if (!bodyText.trim()) return { ok: false, error: 'Body must not be empty.' };

    const newHash = contentHash(message.toEmail, subject, bodyText);
    const changed = newHash !== message.contentHash;

    let approvalRevoked = false;
    if (changed) {
      const revoked = await tx
        .update(messageApprovals)
        .set({ revokedAt: new Date(), revokedReason: 'Message content edited after approval.' })
        .where(and(eq(messageApprovals.messageId, messageId), isNull(messageApprovals.revokedAt)))
        .returning({ id: messageApprovals.id });
      approvalRevoked = revoked.length > 0;
    }

    await tx
      .update(messages)
      .set({
        subject,
        bodyText,
        contentHash: newHash,
        updatedAt: new Date(),
        // Any edit returns the message to the review queue.
        ...(changed ? { status: 'PENDING_APPROVAL' as const } : {}),
      })
      .where(eq(messages.id, messageId));

    if (changed) {
      await recordActivity(
        {
          userId,
          prospectId: message.prospectId,
          type: 'EMAIL_EDITED',
          title: 'Draft edited — re-approval required',
          metadata: { messageId, approvalRevoked },
        },
        tx,
      );

      await recordAudit(
        {
          userId,
          action: 'EMAIL_EDITED',
          entityType: 'message',
          entityId: messageId,
          metadata: { approvalRevoked, previousHash: message.contentHash, newHash },
        },
        tx,
      );
    }

    return { ok: true, approvalRevoked };
  });
}

/**
 * Record an explicit human approval, bound to the exact content hash.
 * `expectedContentHash` is what the reviewer actually saw: if the message
 * changed between rendering the review screen and clicking approve, the
 * approval is refused rather than applied to content nobody read.
 */
export async function approveDraft(
  userId: string,
  messageId: string,
  approvedBy: string,
  expectedContentHash?: string,
): Promise<{ ok: boolean; error?: string; approvalVersion?: number }> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);

    const message = rows[0];
    if (!message) return { ok: false, error: 'Message not found.' };

    if (!['DRAFT', 'PENDING_APPROVAL'].includes(message.status)) {
      return { ok: false, error: `A message that is ${message.status} cannot be approved.` };
    }

    if (expectedContentHash && expectedContentHash !== message.contentHash) {
      return {
        ok: false,
        error: 'The message changed since you opened it. Review the current content and approve again.',
      };
    }

    // Suppression may have arrived between drafting and approval.
    const suppression = await checkSuppression(userId, message.toEmail, tx);
    if (suppression.emailSuppressed || suppression.domainSuppressed) {
      return { ok: false, error: `${message.toEmail} is suppressed and cannot be approved for sending.` };
    }

    const previous = await tx
      .select({ version: messageApprovals.approvalVersion })
      .from(messageApprovals)
      .where(eq(messageApprovals.messageId, messageId))
      .orderBy(desc(messageApprovals.approvalVersion))
      .limit(1);

    const approvalVersion = (previous[0]?.version ?? 0) + 1;

    await tx.insert(messageApprovals).values({
      messageId,
      approvedBy,
      approvalVersion,
      contentHash: message.contentHash,
    });

    await tx
      .update(messages)
      .set({ status: 'APPROVED', updatedAt: new Date() })
      .where(eq(messages.id, messageId));

    await recordActivity(
      {
        userId,
        prospectId: message.prospectId,
        type: 'EMAIL_APPROVED',
        title: `Approved for sending (v${approvalVersion})`,
        metadata: { messageId, approvalVersion },
      },
      tx,
    );

    await recordAudit(
      {
        userId,
        action: 'EMAIL_APPROVED',
        entityType: 'message',
        entityId: messageId,
        metadata: { approvalVersion, contentHash: message.contentHash, approvedBy },
      },
      tx,
    );

    return { ok: true, approvalVersion };
  });
}

export async function rejectDraft(
  userId: string,
  messageId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);

    const message = rows[0];
    if (!message) return { ok: false, error: 'Message not found.' };
    if (['SENT', 'DELIVERED', 'SENDING'].includes(message.status)) {
      return { ok: false, error: `A message that is ${message.status} cannot be rejected.` };
    }

    await tx
      .update(messageApprovals)
      .set({ revokedAt: new Date(), revokedReason: `Rejected: ${reason}` })
      .where(and(eq(messageApprovals.messageId, messageId), isNull(messageApprovals.revokedAt)));

    await tx
      .update(messages)
      .set({ status: 'CANCELLED', blockedReason: reason, updatedAt: new Date() })
      .where(eq(messages.id, messageId));

    await recordAudit(
      {
        userId,
        action: 'EMAIL_REJECTED',
        entityType: 'message',
        entityId: messageId,
        metadata: { reason },
      },
      tx,
    );

    return { ok: true };
  });
}

/** The current, unrevoked approval for a message, if any. */
export async function getCurrentApproval(messageId: string, tx?: Database) {
  const db = tx ?? getDb();
  const rows = await db
    .select()
    .from(messageApprovals)
    .where(and(eq(messageApprovals.messageId, messageId), isNull(messageApprovals.revokedAt)))
    .orderBy(desc(messageApprovals.approvalVersion))
    .limit(1);
  return rows[0] ?? null;
}

/** The review queue: everything a human must look at, richest context first. */
export async function getReviewQueue(userId: string, limit = 50) {
  return getDb()
    .select({
      message: messages,
      prospect: prospects,
      company: companies,
      contact: contacts,
      campaign: campaigns,
    })
    .from(messages)
    .innerJoin(prospects, eq(prospects.id, messages.prospectId))
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .leftJoin(campaignMembers, eq(campaignMembers.id, messages.campaignMemberId))
    .leftJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
    .where(and(eq(messages.userId, userId), eq(messages.status, 'PENDING_APPROVAL')))
    .orderBy(desc(prospects.qualificationScore), desc(messages.createdAt))
    .limit(Math.min(limit, 200));
}

export async function getMessage(userId: string, messageId: string) {
  const rows = await getDb()
    .select({ message: messages, prospect: prospects, company: companies, contact: contacts })
    .from(messages)
    .innerJoin(prospects, eq(prospects.id, messages.prospectId))
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}
