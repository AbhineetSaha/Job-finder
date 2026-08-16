/**
 * The worker: claims jobs and sends email.
 *
 * The worker repeats every safety check itself rather than trusting whatever
 * validated the message earlier (brief §31). All of that logic lives in
 * `sendMessage`, which re-reads the world inside a transaction.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { campaignMembers, campaignSteps, campaigns, contacts, messages, prospects } from '../db/schema.js';
import { getEnv } from '../lib/env.js';
import { incrementMetric, logger } from '../lib/logger.js';
import { sendMessage } from '../services/sending.js';
import { createDraft } from '../services/drafts.js';
import { computeStepDueAt } from '../services/campaigns.js';
import { getConfig } from '../services/config.js';
import {
  claimJobs,
  completeJob,
  deferJob,
  enqueue,
  failJob,
  releaseStuckJobs,
  type JobKind,
} from './queue.js';
import type { Job } from '../db/schema.js';

export interface WorkerOptions {
  workerId: string;
  batchSize?: number;
  pollIntervalMs?: number;
}

/** Process a single claimed job. Never throws — failures are recorded. */
export async function processJob(job: Job): Promise<void> {
  const log = logger.child({ jobId: job.id, event: 'job_process' });

  try {
    switch (job.kind as JobKind) {
      case 'SEND_MESSAGE':
        await handleSendMessage(job);
        break;
      case 'ENQUEUE_NEXT_STEP':
        await handleEnqueueNextStep(job);
        break;
      case 'RETENTION_SWEEP':
        await handleRetentionSweep(job);
        break;
      default:
        await failJob(job, `Unknown job kind: ${job.kind}`);
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    incrementMetric('queue_failures');
    log.error('Job threw', { status: 'error', error: message });
    await failJob(job, message);
  }
}

async function handleSendMessage(job: Job): Promise<void> {
  const messageId = String(job.payload.messageId ?? '');
  if (!messageId) {
    await failJob(job, 'SEND_MESSAGE job has no messageId.');
    return;
  }

  const outcome = await sendMessage(messageId);

  switch (outcome.status) {
    case 'SENT':
      await completeJob(job.id);
      await scheduleNextStep(messageId);
      return;

    case 'BLOCKED':
      if (outcome.transient) {
        // Not a failure: the send is legitimately not allowed *yet*. Retry
        // without consuming an attempt, so a long pause cannot exhaust them.
        const retryAt = outcome.retryAfter ?? new Date(Date.now() + 15 * 60 * 1000);
        await deferJob(job.id, retryAt, `${outcome.reason}: ${outcome.detail}`);
        logger.info('Send deferred', {
          event: 'send_deferred',
          jobId: job.id,
          messageId,
          status: outcome.reason,
        });
        return;
      }
      // A permanent block is a decision, not an error — the job is done.
      await completeJob(job.id);
      logger.warn('Send permanently blocked', {
        event: 'send_blocked',
        jobId: job.id,
        messageId,
        status: outcome.reason,
        error: outcome.detail,
      });
      return;

    case 'FAILED':
      if (outcome.permanent) {
        await completeJob(job.id);
        logger.error('Send permanently failed', {
          event: 'send_failed',
          jobId: job.id,
          messageId,
          status: outcome.errorCode,
          error: outcome.errorMessage,
        });
        return;
      }
      await failJob(job, `${outcome.errorCode}: ${outcome.errorMessage}`);
      return;
  }
}

/**
 * After a successful send, queue the next enabled step of the sequence.
 * Uses a dedupe key so this cannot create two drafts for one step even if the
 * job is somehow processed twice.
 */
async function scheduleNextStep(messageId: string): Promise<void> {
  const db = getDb();

  const rows = await db
    .select({ message: messages })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const message = rows[0]?.message;
  if (!message?.campaignMemberId) return;

  const config = await getConfig(message.userId);
  if (!config.followupEnabled) return;

  await enqueue({
    kind: 'ENQUEUE_NEXT_STEP',
    payload: { campaignMemberId: message.campaignMemberId },
    dedupeKey: `next-step:${message.campaignMemberId}:after:${messageId}`,
  });
}

/**
 * Create the draft for a member's current sequence position and queue its send.
 *
 * The draft is created in PENDING_APPROVAL. Follow-ups are held for human
 * approval exactly like the initial email — the brief's approval requirement
 * has no exemption for later steps.
 */
async function handleEnqueueNextStep(job: Job): Promise<void> {
  const campaignMemberId = String(job.payload.campaignMemberId ?? '');
  if (!campaignMemberId) {
    await failJob(job, 'ENQUEUE_NEXT_STEP job has no campaignMemberId.');
    return;
  }

  const db = getDb();

  const rows = await db
    .select({
      member: campaignMembers,
      campaign: campaigns,
      prospect: prospects,
      contact: contacts,
    })
    .from(campaignMembers)
    .innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
    .innerJoin(prospects, eq(prospects.id, campaignMembers.prospectId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(eq(campaignMembers.id, campaignMemberId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    await completeJob(job.id);
    return;
  }

  // Every reason not to continue, re-checked here rather than assumed.
  if (row.member.status !== 'ACTIVE') {
    await completeJob(job.id);
    return;
  }
  if (row.campaign.status !== 'RUNNING' && row.campaign.status !== 'PAUSED') {
    await completeJob(job.id);
    return;
  }

  const steps = await db
    .select()
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, row.campaign.id))
    .orderBy(campaignSteps.position);

  const step = steps.find((s) => s.position === row.member.currentPosition && s.enabled);

  if (!step) {
    const hasLater = steps.some((s) => s.position > row.member.currentPosition && s.enabled);
    if (!hasLater) {
      await db
        .update(campaignMembers)
        .set({
          status: 'COMPLETED',
          stoppedAt: new Date(),
          stopReason: 'SEQUENCE_COMPLETED',
          updatedAt: new Date(),
        })
        .where(eq(campaignMembers.id, campaignMemberId));
    }
    await completeJob(job.id);
    return;
  }

  const dueAt = computeStepDueAt(
    new Date(),
    step,
    row.campaign,
    row.contact.timezone,
  );

  if (!dueAt) {
    await failJob(job, 'Campaign sending window configuration can never permit a send.');
    return;
  }

  const draft = await createDraft({
    userId: row.prospect.userId,
    prospectId: row.prospect.id,
    templateId: step.templateId,
    serviceId: row.campaign.serviceId,
    // Follow-up personalisation carries over from the initial message's stored
    // variables; the operator edits it in the review queue before approving.
    personalization: {},
    campaignMemberId,
    campaignStepId: step.id,
    scheduledAt: dueAt,
  });

  if (!draft.ok) {
    // A render failure means the template needs values the operator has not
    // supplied. That is a human task, not a retryable error.
    logger.warn('Follow-up draft could not be created', {
      event: 'followup_draft_failed',
      jobId: job.id,
      campaignId: row.campaign.id,
      prospectId: row.prospect.id,
      error: draft.error,
    });
    await completeJob(job.id);
    return;
  }

  incrementMetric('followups');
  await db
    .update(prospects)
    .set({ nextFollowUpAt: dueAt, updatedAt: new Date() })
    .where(eq(prospects.id, row.prospect.id));

  await completeJob(job.id);
}

async function handleRetentionSweep(job: Job): Promise<void> {
  const { purgeOldActivities } = await import('../services/audit.js');
  const userId = String(job.payload.userId ?? '');
  if (!userId) {
    await failJob(job, 'RETENTION_SWEEP job has no userId.');
    return;
  }

  const config = await getConfig(userId);
  if (config.retention.activities) {
    const removed = await purgeOldActivities(userId, config.retention.activities);
    logger.info('Retention sweep complete', { event: 'retention_sweep', userId, removed });
  }
  await completeJob(job.id);
}

/** One polling cycle. Exported so tests can drive the worker deterministically. */
export async function runOnce(options: WorkerOptions): Promise<number> {
  const env = getEnv();
  const batchSize = options.batchSize ?? env.WORKER_BATCH_SIZE;

  await releaseStuckJobs(env.WORKER_VISIBILITY_TIMEOUT_SECONDS);

  const claimed = await claimJobs(options.workerId, batchSize);
  for (const job of claimed) {
    await processJob(job);
  }
  return claimed.length;
}

/** Long-running loop with graceful shutdown. */
export async function runWorker(options: WorkerOptions, signal?: AbortSignal): Promise<void> {
  const env = getEnv();
  const interval = options.pollIntervalMs ?? env.WORKER_POLL_INTERVAL_MS;

  logger.info('Worker started', {
    event: 'worker_started',
    workerId: options.workerId,
    status: env.EMAIL_MODE,
  });

  while (!signal?.aborted) {
    try {
      const processed = await runOnce(options);
      if (processed === 0) {
        await sleep(interval, signal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      incrementMetric('queue_failures');
      logger.error('Worker cycle failed', { event: 'worker_cycle_failed', error: message });
      await sleep(interval, signal);
    }
  }

  logger.info('Worker stopped', { event: 'worker_stopped', workerId: options.workerId });
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
