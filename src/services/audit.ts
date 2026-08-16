/**
 * Audit log and prospect activity timeline.
 *
 * `audit_logs` is append-only: this module offers insert and read, and there is
 * deliberately no update or delete anywhere in the application
 * (docs/security.md).
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import { activities, auditLogs, prospects } from '../db/schema.js';

export const AUDIT_ACTIONS = [
  'USER_CREATED',
  'USER_LOGIN',
  'USER_LOGIN_FAILED',
  'USER_LOGOUT',
  'PROSPECT_CREATED',
  'PROSPECT_IMPORTED',
  'PROSPECT_UPDATED',
  'PROSPECT_DELETED',
  'PROSPECT_QUALIFIED',
  'PROSPECT_STATUS_CHANGED',
  'PROSPECT_APPROVED',
  'RESEARCH_UPDATED',
  'EMAIL_DRAFT_CREATED',
  'EMAIL_EDITED',
  'EMAIL_APPROVED',
  'EMAIL_APPROVAL_REVOKED',
  'EMAIL_REJECTED',
  'EMAIL_SCHEDULED',
  'EMAIL_SENT',
  'EMAIL_BLOCKED',
  'EMAIL_FAILED',
  'EMAIL_DELIVERED',
  'EMAIL_BOUNCED',
  'REPLY_RECEIVED',
  'REPLY_CLASSIFIED',
  'SEQUENCE_STARTED',
  'SEQUENCE_STOPPED',
  'SUPPRESSION_ADDED',
  'SUPPRESSION_REMOVED',
  'CAMPAIGN_CREATED',
  'CAMPAIGN_STARTED',
  'CAMPAIGN_PAUSED',
  'CAMPAIGN_RESUMED',
  'CAMPAIGN_ARCHIVED',
  'GLOBAL_PAUSE_ENABLED',
  'GLOBAL_PAUSE_DISABLED',
  'MEETING_CREATED',
  'MEETING_UPDATED',
  'DEAL_CREATED',
  'DEAL_UPDATED',
  'DEAL_WON',
  'DEAL_LOST',
  'SETTINGS_UPDATED',
  'DATA_EXPORTED',
  'WEBHOOK_RECEIVED',
  'WEBHOOK_REJECTED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditInput {
  userId: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'WEBHOOK';
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
}

/** Record an audited action. Accepts a transaction so the log commits atomically with the change. */
export async function recordAudit(input: AuditInput, tx?: Database): Promise<void> {
  const db = tx ?? getDb();
  await db.insert(auditLogs).values({
    userId: input.userId,
    actorType: input.actorType ?? 'USER',
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
  });
}

export interface ActivityInput {
  userId: string;
  prospectId: string;
  type: string;
  title: string;
  body?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export async function recordActivity(input: ActivityInput, tx?: Database): Promise<void> {
  const db = tx ?? getDb();
  await db.insert(activities).values({
    userId: input.userId,
    prospectId: input.prospectId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    metadata: input.metadata ?? {},
  });
}

export async function getProspectTimeline(userId: string, prospectId: string, limit = 100) {
  return getDb()
    .select()
    .from(activities)
    .where(and(eq(activities.userId, userId), eq(activities.prospectId, prospectId)))
    .orderBy(desc(activities.occurredAt))
    .limit(Math.min(limit, 200));
}

export async function getAuditLog(
  userId: string,
  options: { entityType?: string; entityId?: string; action?: string; limit?: number } = {},
) {
  const conditions = [eq(auditLogs.userId, userId)];
  if (options.entityType) conditions.push(eq(auditLogs.entityType, options.entityType));
  if (options.entityId) conditions.push(eq(auditLogs.entityId, options.entityId));
  if (options.action) conditions.push(eq(auditLogs.action, options.action));

  return getDb()
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

/**
 * Retention sweep for activities. Audit logs are deliberately exempt: the
 * record of what was sent to whom is the evidence that outreach was handled
 * responsibly, and deleting it to save space would be self-defeating.
 */
export async function purgeOldActivities(userId: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await getDb()
    .delete(activities)
    .where(and(eq(activities.userId, userId), lt(activities.occurredAt, cutoff)))
    .returning({ id: activities.id });
  return deleted.length;
}

/** Count of prospects per status, used by the dashboard. */
export async function countProspectsByStatus(userId: string): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ status: prospects.status, count: sql<number>`count(*)::int` })
    .from(prospects)
    .where(eq(prospects.userId, userId))
    .groupBy(prospects.status);

  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row.count;
  return result;
}
