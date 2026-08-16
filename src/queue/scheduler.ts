/**
 * The scheduler: turns approved, due messages into queued jobs, and runs
 * periodic housekeeping.
 *
 * It never sends. It also never enqueues while sending is globally paused, so
 * a pause does not build up a backlog that floods the moment it is lifted.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { messages, settings } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { purgeExpiredSessions } from '../lib/session.js';
import { findDueMessages } from '../services/sending.js';
import { enqueue, purgeCompletedJobs, releaseStuckJobs } from './queue.js';
import { getEnv } from '../lib/env.js';

export interface SchedulerResult {
  enqueued: number;
  skippedPaused: number;
  released: number;
}

/** One scheduling pass. Exported so tests and `--once` can drive it. */
export async function runSchedulerOnce(): Promise<SchedulerResult> {
  const db = getDb();
  const env = getEnv();

  const released = await releaseStuckJobs(env.WORKER_VISIBILITY_TIMEOUT_SECONDS);

  const pausedUsers = new Set(
    (
      await db
        .select({ userId: settings.userId })
        .from(settings)
        .where(eq(settings.globalSendPaused, true))
    ).map((row) => row.userId),
  );

  const due = await findDueMessages(200);

  let enqueued = 0;
  let skippedPaused = 0;

  for (const message of due) {
    if (pausedUsers.has(message.userId)) {
      skippedPaused += 1;
      continue;
    }

    // Dedupe on the message id: re-running the scheduler cannot double-queue a
    // send, and the job survives until the worker completes or cancels it.
    const job = await enqueue({
      kind: 'SEND_MESSAGE',
      payload: { messageId: message.id },
      dedupeKey: `send:${message.id}`,
    });

    if (job) {
      enqueued += 1;
      await db
        .update(messages)
        .set({ status: 'QUEUED', updatedAt: new Date() })
        .where(eq(messages.id, message.id));
    }
  }

  if (enqueued > 0 || skippedPaused > 0) {
    logger.info('Scheduler pass complete', {
      event: 'scheduler_pass',
      enqueued,
      skippedPaused,
      released,
    });
  }

  return { enqueued, skippedPaused, released };
}

/** Less frequent housekeeping. */
export async function runHousekeeping(): Promise<void> {
  const [sessionsPurged, jobsPurged] = await Promise.all([
    purgeExpiredSessions(),
    purgeCompletedJobs(7),
  ]);

  if (sessionsPurged > 0 || jobsPurged > 0) {
    logger.info('Housekeeping complete', {
      event: 'housekeeping',
      sessionsPurged,
      jobsPurged,
    });
  }
}

export async function runScheduler(
  intervalMs = 60_000,
  signal?: AbortSignal,
): Promise<void> {
  logger.info('Scheduler started', { event: 'scheduler_started' });

  let cyclesSinceHousekeeping = 0;

  while (!signal?.aborted) {
    try {
      await runSchedulerOnce();
      cyclesSinceHousekeeping += 1;
      // Roughly hourly at the default interval.
      if (cyclesSinceHousekeeping >= 60) {
        await runHousekeeping();
        cyclesSinceHousekeeping = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Scheduler cycle failed', { event: 'scheduler_cycle_failed', error: message });
    }

    await sleep(intervalMs, signal);
  }

  logger.info('Scheduler stopped', { event: 'scheduler_stopped' });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
