/**
 * Suppression list.
 *
 * A suppressed address must never receive another automated outreach email,
 * under any circumstance (brief §25, §66.2). Every send path consults
 * `checkSuppression`, and the worker consults it again inside the send
 * transaction.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  campaignMembers,
  contacts,
  prospects,
  suppressionList,
  type Suppression,
} from '../db/schema.js';
import { emailDomain, normalizeDomain, normalizeEmail } from '../domain/normalize.js';
import { recordActivity, recordAudit } from './audit.js';
import { logger } from '../lib/logger.js';

export type SuppressionReason =
  | 'UNSUBSCRIBED'
  | 'DO_NOT_CONTACT'
  | 'BOUNCED'
  | 'INVALID'
  | 'MANUAL_BLOCK';

export interface SuppressionCheck {
  emailSuppressed: boolean;
  domainSuppressed: boolean;
  reason: SuppressionReason | null;
  detail: string | null;
}

const NOT_SUPPRESSED: SuppressionCheck = {
  emailSuppressed: false,
  domainSuppressed: false,
  reason: null,
  detail: null,
};

/**
 * Is this address suppressed, by address or by whole domain?
 *
 * An address that fails to normalise is reported as suppressed. That is
 * deliberate: an address the system cannot reason about is one it must not
 * send to (brief §66.15).
 */
export async function checkSuppression(
  userId: string,
  email: string,
  tx?: Database,
): Promise<SuppressionCheck> {
  const db = tx ?? getDb();
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return {
      emailSuppressed: true,
      domainSuppressed: false,
      reason: 'INVALID',
      detail: `"${email}" could not be normalised to a valid address.`,
    };
  }

  const domain = emailDomain(normalized);

  const rows = await db
    .select()
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.userId, userId),
        isNull(suppressionList.removedAt),
        sql`(
          (${suppressionList.scope} = 'EMAIL' and ${suppressionList.normalizedEmail} = ${normalized})
          or (${suppressionList.scope} = 'DOMAIN' and ${suppressionList.normalizedDomain} = ${domain})
        )`,
      ),
    );

  if (rows.length === 0) return NOT_SUPPRESSED;

  const emailRow = rows.find((r) => r.scope === 'EMAIL');
  const domainRow = rows.find((r) => r.scope === 'DOMAIN');
  const primary = emailRow ?? domainRow;

  return {
    emailSuppressed: Boolean(emailRow),
    domainSuppressed: Boolean(domainRow),
    reason: (primary?.reason as SuppressionReason) ?? null,
    detail: primary?.note ?? `Suppressed (${primary?.reason ?? 'unknown reason'}).`,
  };
}

export interface AddSuppressionInput {
  userId: string;
  email?: string | null;
  domain?: string | null;
  reason: SuppressionReason;
  note?: string | null;
  createdBy?: string | null;
  /** Also stop any active sequence for the matching contact. Default true. */
  stopSequences?: boolean;
}

/**
 * Add a suppression entry and, by default, immediately stop any active
 * sequence for the affected contact. Suppressing without stopping would leave
 * a queued follow-up that the preflight blocks but that still sits in the
 * queue confusing the operator.
 */
export async function addSuppression(input: AddSuppressionInput): Promise<Suppression | null> {
  const db = getDb();
  const normalizedEmail = input.email ? normalizeEmail(input.email) : null;
  const normalizedDomain = input.domain ? normalizeDomain(input.domain) : null;

  if (!normalizedEmail && !normalizedDomain) {
    throw new Error('Suppression requires a valid email address or domain.');
  }

  const scope = normalizedEmail ? 'EMAIL' : 'DOMAIN';

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(suppressionList)
      .values({
        userId: input.userId,
        scope,
        normalizedEmail: scope === 'EMAIL' ? normalizedEmail : null,
        normalizedDomain: scope === 'DOMAIN' ? normalizedDomain : null,
        reason: input.reason,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      })
      // Already suppressed is success, not an error: the desired state holds.
      .onConflictDoNothing()
      .returning();

    const row = inserted[0] ?? null;

    await recordAudit(
      {
        userId: input.userId,
        action: 'SUPPRESSION_ADDED',
        entityType: 'suppression',
        entityId: row?.id ?? null,
        metadata: {
          scope,
          target: normalizedEmail ?? normalizedDomain,
          reason: input.reason,
          alreadyPresent: !row,
        },
      },
      tx,
    );

    if (input.stopSequences !== false && normalizedEmail) {
      await stopSequencesForEmail(tx, input.userId, normalizedEmail, input.reason);
    }

    logger.info('Suppression added', {
      event: 'suppression_added',
      userId: input.userId,
      status: row ? 'created' : 'already_present',
    });

    return row;
  });
}

/**
 * Removing a suppression is possible but deliberately awkward: it is audited,
 * requires a reason, and never applies to UNSUBSCRIBED entries. Honouring an
 * unsubscribe is not a preference the operator can toggle off.
 */
export async function removeSuppression(
  userId: string,
  suppressionId: string,
  removedBy: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();

  const rows = await db
    .select()
    .from(suppressionList)
    .where(and(eq(suppressionList.id, suppressionId), eq(suppressionList.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, error: 'Suppression entry not found.' };
  if (row.removedAt) return { ok: false, error: 'That entry has already been removed.' };
  if (row.reason === 'UNSUBSCRIBED') {
    return {
      ok: false,
      error:
        'An unsubscribe cannot be reversed. The recipient asked not to be contacted, and that request is permanent.',
    };
  }
  if (!reason.trim()) return { ok: false, error: 'A reason is required to remove a suppression.' };

  await db.transaction(async (tx) => {
    await tx
      .update(suppressionList)
      .set({ removedAt: new Date(), removedBy, removedReason: reason.trim() })
      .where(eq(suppressionList.id, suppressionId));

    await recordAudit(
      {
        userId,
        action: 'SUPPRESSION_REMOVED',
        entityType: 'suppression',
        entityId: suppressionId,
        metadata: {
          previousReason: row.reason,
          target: row.normalizedEmail ?? row.normalizedDomain,
          removalReason: reason.trim(),
        },
      },
      tx,
    );
  });

  return { ok: true };
}

export async function listSuppressions(userId: string, includeRemoved = false) {
  const conditions = [eq(suppressionList.userId, userId)];
  if (!includeRemoved) conditions.push(isNull(suppressionList.removedAt));

  return getDb()
    .select()
    .from(suppressionList)
    .where(and(...conditions))
    .orderBy(desc(suppressionList.createdAt))
    .limit(500);
}

/** Stop every active enrolment belonging to a suppressed address. */
async function stopSequencesForEmail(
  tx: Database,
  userId: string,
  normalizedEmail: string,
  reason: SuppressionReason,
): Promise<void> {
  const affected = await tx
    .select({ prospectId: prospects.id, memberId: campaignMembers.id })
    .from(prospects)
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .innerJoin(campaignMembers, eq(campaignMembers.prospectId, prospects.id))
    .where(
      and(
        eq(prospects.userId, userId),
        eq(contacts.normalizedEmail, normalizedEmail),
        eq(campaignMembers.status, 'ACTIVE'),
      ),
    );

  if (affected.length === 0) return;

  const stopReason = reason === 'BOUNCED' ? 'BOUNCED' : reason === 'INVALID' ? 'SUPPRESSED' : 'SUPPRESSED';

  await tx
    .update(campaignMembers)
    .set({ status: 'STOPPED', stoppedAt: new Date(), stopReason, updatedAt: new Date() })
    .where(
      inArray(
        campaignMembers.id,
        affected.map((a) => a.memberId),
      ),
    );

  for (const row of affected) {
    await recordActivity(
      {
        userId,
        prospectId: row.prospectId,
        type: 'SEQUENCE_STOPPED',
        title: 'Sequence stopped: contact suppressed',
        body: `Suppression reason: ${reason}`,
      },
      tx,
    );
  }
}
