/**
 * PostgreSQL-backed job queue.
 *
 * Chosen over an external broker so a job and the business rows it refers to
 * commit in the same transaction — there is no window in which a job exists
 * for a message that does not (docs/architecture.md §6).
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import { jobs, type Job } from '../db/schema.js';
import { getEnv } from '../lib/env.js';
import { retryDelaySeconds } from '../domain/ratelimit.js';
import { logger } from '../lib/logger.js';

export type JobKind = 'SEND_MESSAGE' | 'ENQUEUE_NEXT_STEP' | 'RETENTION_SWEEP';

export interface EnqueueInput {
  kind: JobKind;
  payload: Record<string, unknown>;
  runAfter?: Date;
  maxAttempts?: number;
  /** When set, a second enqueue with the same key is a no-op. */
  dedupeKey?: string;
}

/**
 * Enqueue a job. With a dedupe key this is idempotent, so a scheduler that
 * runs twice — or two schedulers — cannot create two sends for one step.
 */
export async function enqueue(input: EnqueueInput, tx?: Database): Promise<Job | null> {
  const db = tx ?? getDb();
  const rows = await db
    .insert(jobs)
    .values({
      kind: input.kind,
      payload: input.payload,
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? getEnv().JOB_MAX_ATTEMPTS,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning();

  return rows[0] ?? null;
}

/**
 * Claim up to `batchSize` due jobs.
 *
 * `FOR UPDATE SKIP LOCKED` lets multiple workers claim disjoint sets without
 * blocking each other, which is what makes horizontal scaling of the worker
 * safe.
 */
export async function claimJobs(workerId: string, batchSize: number): Promise<Job[]> {
  const db = getDb();

  // Raw SQL is required for the SKIP LOCKED CTE, but it returns snake_case
  // columns that do not match the Job type. Claim ids here, then re-select
  // through the query builder so callers get correctly mapped rows.
  const claimed = await db.execute<{ id: string }>(sql`
    with claimed as (
      select id from ${jobs}
       where ${jobs.status} = 'PENDING'
         and ${jobs.runAfter} <= now()
       order by ${jobs.runAfter}
       for update skip locked
       limit ${batchSize}
    )
    update ${jobs}
       set status = 'CLAIMED',
           claimed_at = now(),
           claimed_by = ${workerId},
           attempts = ${jobs.attempts} + 1,
           updated_at = now()
     where ${jobs.id} in (select id from claimed)
    returning ${jobs.id}
  `);

  const ids = (claimed.rows ?? []).map((row) => row.id);
  if (ids.length === 0) return [];

  return db.select().from(jobs).where(inArray(jobs.id, ids)).orderBy(jobs.runAfter);
}

export async function completeJob(jobId: string): Promise<void> {
  await getDb()
    .update(jobs)
    .set({ status: 'DONE', updatedAt: new Date(), lastError: null })
    .where(eq(jobs.id, jobId));
}

/**
 * Record a failure. Retries with exponential backoff and full jitter until
 * `max_attempts`, then the job is marked FAILED and stops — an unbounded retry
 * loop against a permanently broken job is worse than a visible failure.
 */
export async function failJob(job: Job, error: string): Promise<void> {
  const db = getDb();

  if (job.attempts >= job.maxAttempts) {
    await db
      .update(jobs)
      .set({ status: 'FAILED', lastError: error.slice(0, 2000), updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    logger.error('Job permanently failed', {
      event: 'job_failed',
      jobId: job.id,
      status: 'FAILED',
      error,
    });
    return;
  }

  const delaySeconds = retryDelaySeconds(job.attempts);
  await db
    .update(jobs)
    .set({
      status: 'PENDING',
      runAfter: new Date(Date.now() + delaySeconds * 1000),
      lastError: error.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));

  logger.warn('Job retry scheduled', {
    event: 'job_retry',
    jobId: job.id,
    status: 'PENDING',
    error,
    attempts: job.attempts,
    delaySeconds,
  });
}

/** Defer a job without consuming an attempt — used for "not yet", not "failed". */
export async function deferJob(jobId: string, runAfter: Date, note: string): Promise<void> {
  await getDb()
    .update(jobs)
    .set({
      status: 'PENDING',
      runAfter,
      lastError: note.slice(0, 2000),
      // A deferral is not a failure, so give the attempt back.
      attempts: sql`greatest(0, ${jobs.attempts} - 1)`,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

export async function cancelJob(jobId: string, reason: string): Promise<void> {
  await getDb()
    .update(jobs)
    .set({ status: 'CANCELLED', lastError: reason.slice(0, 2000), updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

/**
 * Release jobs whose worker died mid-flight. Bounded by max_attempts, so a job
 * that reliably kills its worker cannot loop forever.
 */
export async function releaseStuckJobs(visibilityTimeoutSeconds: number): Promise<number> {
  const cutoff = new Date(Date.now() - visibilityTimeoutSeconds * 1000);
  const released = await getDb()
    .update(jobs)
    .set({
      status: 'PENDING',
      claimedAt: null,
      claimedBy: null,
      lastError: 'Released after exceeding the visibility timeout.',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.status, 'CLAIMED'),
        lt(jobs.claimedAt, cutoff),
        lt(jobs.attempts, sql`${jobs.maxAttempts}`),
      ),
    )
    .returning({ id: jobs.id });

  if (released.length > 0) {
    logger.warn('Released stuck jobs', { event: 'jobs_released', count: released.length });
  }
  return released.length;
}

export interface QueueStats {
  pending: number;
  claimed: number;
  failed: number;
  done: number;
  cancelled: number;
  oldestPendingAgeSeconds: number | null;
}

export async function getQueueStats(): Promise<QueueStats> {
  const db = getDb();

  const counts = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);

  const oldest = await db
    .select({ runAfter: jobs.runAfter })
    .from(jobs)
    .where(eq(jobs.status, 'PENDING'))
    .orderBy(jobs.runAfter)
    .limit(1);

  const byStatus: Record<string, number> = {};
  for (const row of counts) byStatus[row.status] = row.count;

  const oldestRunAfter = oldest[0]?.runAfter;

  return {
    pending: byStatus.PENDING ?? 0,
    claimed: byStatus.CLAIMED ?? 0,
    failed: byStatus.FAILED ?? 0,
    done: byStatus.DONE ?? 0,
    cancelled: byStatus.CANCELLED ?? 0,
    oldestPendingAgeSeconds: oldestRunAfter
      ? Math.max(0, Math.floor((Date.now() - oldestRunAfter.getTime()) / 1000))
      : null,
  };
}

export async function listFailedJobs(limit = 50): Promise<Job[]> {
  return getDb()
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'FAILED'))
    .orderBy(sql`${jobs.updatedAt} desc`)
    .limit(limit);
}

/** Re-queue a failed job, resetting its attempt count. */
export async function retryJob(jobId: string): Promise<boolean> {
  const rows = await getDb()
    .update(jobs)
    .set({ status: 'PENDING', attempts: 0, runAfter: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'FAILED')))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Housekeeping: completed jobs are not history, they are exhaust. */
export async function purgeCompletedJobs(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await getDb()
    .delete(jobs)
    .where(and(eq(jobs.status, 'DONE'), lt(jobs.updatedAt, cutoff)))
    .returning({ id: jobs.id });
  return deleted.length;
}
