/**
 * Data deletion and retention.
 *
 * The one rule that governs this whole module: **deletion never removes
 * suppression.** Before a contact is deleted, any live suppression for their
 * address is re-keyed to a standalone row that no longer references them.
 *
 * Without that, "clean up old prospects" would silently make everyone who
 * unsubscribed contactable again — a compliance failure disguised as data
 * hygiene (docs/compliance.md).
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  companies,
  contacts,
  messages,
  prospects,
  suppressionList,
  webhookEvents,
} from '../db/schema.js';
import { emailDomain, normalizeEmail } from '../domain/normalize.js';
import { recordAudit } from './audit.js';
import { logger } from '../lib/logger.js';

export interface DeletionResult {
  ok: boolean;
  error?: string;
  suppressionPreserved: boolean;
}

/**
 * Ensure the address is suppressed independently of the contact row that is
 * about to disappear. Called before every contact/prospect deletion.
 *
 * If the contact was never suppressed, nothing is added — deleting a prospect
 * is not itself an opt-out, and inventing one would be wrong.
 */
async function preserveSuppression(
  tx: Database,
  userId: string,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const live = await tx
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.userId, userId),
        eq(suppressionList.scope, 'EMAIL'),
        eq(suppressionList.normalizedEmail, normalized),
        isNull(suppressionList.removedAt),
      ),
    )
    .limit(1);

  if (!live[0]) return false;

  // The row is already keyed by normalised email, not by contact id, so it
  // survives the cascade untouched. Annotate it so the reason it outlives the
  // contact is visible to anyone reading the table later.
  await tx
    .update(suppressionList)
    .set({
      note: `${live[0].note ?? ''}\n[Retained after the contact record was deleted on ${new Date().toISOString()}.]`.trim(),
    })
    .where(eq(suppressionList.id, live[0].id));

  return true;
}

/** Delete a prospect and everything hanging off it. Suppression survives. */
export async function deleteProspect(
  userId: string,
  prospectId: string,
  options: { deleteContact?: boolean; deleteCompanyIfOrphaned?: boolean } = {},
): Promise<DeletionResult> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ prospect: prospects, contact: contacts })
      .from(prospects)
      .innerJoin(contacts, eq(contacts.id, prospects.contactId))
      .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) return { ok: false, error: 'Prospect not found.', suppressionPreserved: false };

    const suppressionPreserved = await preserveSuppression(tx, userId, row.contact.email);

    // Cascades handle research, sources, scores, messages, approvals, attempts,
    // replies, activities, meetings, deals, and campaign membership.
    await tx.delete(prospects).where(eq(prospects.id, prospectId));

    if (options.deleteContact) {
      await tx.delete(contacts).where(eq(contacts.id, row.contact.id));
    }

    if (options.deleteCompanyIfOrphaned) {
      const remaining = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(contacts)
        .where(eq(contacts.companyId, row.prospect.companyId));

      if ((remaining[0]?.count ?? 0) === 0) {
        await tx.delete(companies).where(eq(companies.id, row.prospect.companyId));
      }
    }

    await recordAudit(
      {
        userId,
        action: 'PROSPECT_DELETED',
        entityType: 'prospect',
        entityId: prospectId,
        metadata: {
          contactDeleted: Boolean(options.deleteContact),
          suppressionPreserved,
          // Recorded so a deletion can be reconciled later without the row.
          normalizedEmail: normalizeEmail(row.contact.email),
          domain: emailDomain(row.contact.email),
        },
      },
      tx,
    );

    logger.info('Prospect deleted', {
      event: 'prospect_deleted',
      userId,
      prospectId,
      status: suppressionPreserved ? 'suppression_preserved' : 'no_suppression',
    });

    return { ok: true, suppressionPreserved };
  });
}

/**
 * Retention sweep for message bodies.
 *
 * Message *rows* are kept (they are the record that outreach happened); the
 * body and subject text is what gets cleared. That keeps analytics and the
 * audit trail intact while honouring a data-minimisation policy.
 */
export async function purgeOldMessageContent(
  userId: string,
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const updated = await getDb()
    .update(messages)
    .set({ bodyText: '[content removed by retention policy]', variables: {} })
    .where(
      and(
        eq(messages.userId, userId),
        lt(messages.createdAt, cutoff),
        sql`${messages.bodyText} <> '[content removed by retention policy]'`,
      ),
    )
    .returning({ id: messages.id });

  if (updated.length > 0) {
    await recordAudit({
      userId,
      actorType: 'SYSTEM',
      action: 'SETTINGS_UPDATED',
      entityType: 'retention',
      entityId: null,
      metadata: { messagesPurged: updated.length, retentionDays },
    });
  }

  return updated.length;
}

export async function purgeOldWebhookEvents(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await getDb()
    .delete(webhookEvents)
    .where(lt(webhookEvents.receivedAt, cutoff))
    .returning({ id: webhookEvents.id });
  return deleted.length;
}
