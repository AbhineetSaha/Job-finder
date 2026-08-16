/**
 * Operational controls (brief §56).
 *
 * "Pause all" must stop queued messages, not just new ones. It works because
 * the flag is re-read inside the send transaction for every job, so the worker
 * sees it even for work it has already claimed.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { activities, companies, contacts, messages, prospects, settings } from '../db/schema.js';
import { toCsv } from '../domain/csv.js';
import { recordAudit } from './audit.js';
import { ensureSettings } from './config.js';
import { pauseAllCampaigns } from './campaigns.js';
import { getQueueStats, listFailedJobs, retryJob } from '../queue/queue.js';
import { snapshotMetrics } from '../lib/logger.js';

export async function setGlobalPause(
  userId: string,
  paused: boolean,
  reason: string,
): Promise<{ ok: boolean; campaignsPaused?: number }> {
  await ensureSettings(userId);

  await getDb()
    .update(settings)
    .set({
      globalSendPaused: paused,
      globalPauseReason: paused ? reason : null,
      globalPausedAt: paused ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(settings.userId, userId));

  await recordAudit({
    userId,
    action: paused ? 'GLOBAL_PAUSE_ENABLED' : 'GLOBAL_PAUSE_DISABLED',
    entityType: 'settings',
    entityId: userId,
    metadata: { reason },
  });

  // Also pause the campaigns themselves, so resuming is a deliberate two-step
  // act rather than an accidental flood the moment the flag flips back.
  const campaignsPaused = paused ? await pauseAllCampaigns(userId, reason) : 0;

  return { ok: true, campaignsPaused };
}

export async function isGloballyPaused(userId: string): Promise<boolean> {
  const row = await ensureSettings(userId);
  return row.globalSendPaused;
}

export async function getOperationsSnapshot(userId: string) {
  const [queue, failedJobs, blockedMessages, failedMessages] = await Promise.all([
    getQueueStats(),
    listFailedJobs(25),
    getDb()
      .select({ message: messages, contact: contacts })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .where(and(eq(messages.userId, userId), eq(messages.status, 'BLOCKED')))
      .orderBy(desc(messages.updatedAt))
      .limit(25),
    getDb()
      .select({ message: messages, contact: contacts })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .where(and(eq(messages.userId, userId), eq(messages.status, 'FAILED')))
      .orderBy(desc(messages.updatedAt))
      .limit(25),
  ]);

  return {
    queue,
    failedJobs,
    blockedMessages,
    failedMessages,
    metrics: snapshotMetrics(),
    paused: await isGloballyPaused(userId),
  };
}

/** Re-queue a failed send after the underlying problem has been fixed. */
export async function retryFailedMessage(
  userId: string,
  messageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();

  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
    .limit(1);

  const message = rows[0];
  if (!message) return { ok: false, error: 'Message not found.' };
  if (!['FAILED', 'BLOCKED'].includes(message.status)) {
    return { ok: false, error: `Only FAILED or BLOCKED messages can be retried; this is ${message.status}.` };
  }

  // Back to APPROVED, not straight to QUEUED: the scheduler re-enqueues it and
  // the worker re-runs the full preflight, including the approval-currency check.
  await db
    .update(messages)
    .set({ status: 'APPROVED', blockedReason: null, updatedAt: new Date() })
    .where(eq(messages.id, messageId));

  await recordAudit({
    userId,
    action: 'EMAIL_SCHEDULED',
    entityType: 'message',
    entityId: messageId,
    metadata: { retriedFrom: message.status },
  });

  return { ok: true };
}

export async function retryFailedJob(jobId: string): Promise<boolean> {
  return retryJob(jobId);
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Export prospects as CSV. Cells are escaped against formula injection so
 * opening the file in a spreadsheet cannot execute anything (docs/security.md).
 */
export async function exportProspectsCsv(userId: string): Promise<string> {
  const rows = await getDb()
    .select({ prospect: prospects, company: companies, contact: contacts })
    .from(prospects)
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(eq(prospects.userId, userId))
    .orderBy(desc(prospects.createdAt));

  const headers = [
    'company_name',
    'company_domain',
    'company_website',
    'company_linkedin_url',
    'country',
    'state',
    'city',
    'timezone',
    'industry',
    'company_size',
    'funding_stage',
    'company_description',
    'technology_stack',
    'contact_name',
    'contact_first_name',
    'contact_last_name',
    'contact_role',
    'contact_email',
    'contact_linkedin_url',
    'source',
    'source_url',
    'qualification_score',
    'qualification_band',
    'status',
    'notes',
    'created_at',
    'updated_at',
    'last_contacted_at',
    'next_follow_up_at',
  ];

  const data = rows.map(({ prospect, company, contact }) => [
    company.name,
    company.normalizedDomain,
    company.website,
    company.linkedinUrl,
    company.country,
    company.state,
    company.city,
    company.timezone,
    company.industry,
    company.companySize,
    company.fundingStage,
    company.description,
    company.technologyStack.join('; '),
    contact.fullName,
    contact.firstName,
    contact.lastName,
    contact.role,
    contact.email,
    contact.linkedinUrl,
    company.source,
    company.sourceUrl,
    prospect.qualificationScore?.toString() ?? '',
    prospect.qualificationBand ?? '',
    prospect.status,
    prospect.notes,
    prospect.createdAt.toISOString(),
    prospect.updatedAt.toISOString(),
    prospect.lastContactedAt?.toISOString() ?? '',
    prospect.nextFollowUpAt?.toISOString() ?? '',
  ]);

  await recordAudit({
    userId,
    action: 'DATA_EXPORTED',
    entityType: 'prospect',
    entityId: null,
    metadata: { format: 'csv', rows: data.length },
  });

  return toCsv(headers, data);
}

export async function exportActivitiesCsv(userId: string): Promise<string> {
  const rows = await getDb()
    .select({ activity: activities, company: companies, contact: contacts })
    .from(activities)
    .innerJoin(prospects, eq(prospects.id, activities.prospectId))
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(eq(activities.userId, userId))
    .orderBy(desc(activities.occurredAt))
    .limit(50_000);

  const headers = ['occurred_at', 'type', 'title', 'body', 'company_name', 'contact_email'];
  const data = rows.map(({ activity, company, contact }) => [
    activity.occurredAt.toISOString(),
    activity.type,
    activity.title,
    activity.body,
    company.name,
    contact.email,
  ]);

  await recordAudit({
    userId,
    action: 'DATA_EXPORTED',
    entityType: 'activity',
    entityId: null,
    metadata: { format: 'csv', rows: data.length },
  });

  return toCsv(headers, data);
}

export async function getMetricsForApi(userId: string) {
  const queue = await getQueueStats();
  const paused = await isGloballyPaused(userId);

  const bounceRow = await getDb()
    .select({
      sent: sql<number>`count(*) filter (where ${messages.status} in ('SENT','DELIVERED','BOUNCED'))::int`,
      bounced: sql<number>`count(*) filter (where ${messages.status} = 'BOUNCED')::int`,
    })
    .from(messages)
    .where(eq(messages.userId, userId));

  const sent = bounceRow[0]?.sent ?? 0;
  const bounced = bounceRow[0]?.bounced ?? 0;

  return {
    ...snapshotMetrics(),
    queue_depth: queue.pending,
    oldest_pending_job_age_seconds: queue.oldestPendingAgeSeconds ?? 0,
    queue_failed: queue.failed,
    global_send_paused: paused ? 1 : 0,
    bounce_rate_percent: sent > 0 ? Math.round((bounced / sent) * 1000) / 10 : 0,
  };
}
