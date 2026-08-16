/**
 * Integration tests for the business safety rules of brief §66, exercised
 * against a real database and the mock provider.
 *
 * These complement tests/unit/safety.test.ts: that file proves the decision
 * function is correct, this one proves the pipeline actually consults it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../src/db/client.js';
import {
  campaignMembers,
  jobs,
  messageAttempts,
  messages,
  prospects,
  settings,
  suppressionList,
  unsubscribeTokens,
} from '../../src/db/schema.js';
import {
  createTestUser,
  enrollInOpenCampaign,
  ensureSchema,
  truncateAll,
  type TestUser,
} from '../helpers/db.js';
import { createProspect } from '../../src/services/prospects.js';
import { approveDraft, createDraft } from '../../src/services/drafts.js';
import { sendMessage } from '../../src/services/sending.js';
import { addSuppression, checkSuppression, removeSuppression } from '../../src/services/suppression.js';
import { setCampaignStatus, stopSequence } from '../../src/services/campaigns.js';
import { processUnsubscribe, recordManualReply } from '../../src/services/events.js';
import { deleteProspect } from '../../src/services/deletion.js';
import { setGlobalPause } from '../../src/services/ops.js';
import { getMockSentMessages, addMockFailure } from '../../src/email/providers/mock.js';
import { enqueue, claimJobs, failJob } from '../../src/queue/queue.js';
import { runOnce } from '../../src/queue/worker.js';
import { sha256 } from '../../src/lib/crypto.js';
import { services } from '../../src/db/schema.js';

let user: TestUser;

const PERSONALIZATION = {
  specificObservation: 'your public engineering blog post about database migrations',
  engineeringSignal: 'an open backend role',
  painPoint: 'migration safety on a live database',
  whyRelevant: 'this is my core work',
  specificOffer: 'a fixed-scope migration review',
  relevantTechnology: 'PostgreSQL',
};

beforeAll(async () => {
  await ensureSchema();
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  user = await createTestUser();
});

async function serviceId(): Promise<string> {
  const rows = await getDb().select().from(services).where(eq(services.userId, user.userId)).limit(1);
  return rows[0]!.id;
}

/** Create a prospect enrolled in a running, always-open campaign with an approved draft. */
async function readyToSend(email = 'target@ready-co.example') {
  const created = await createProspect({
    userId: user.userId,
    companyName: `Ready Co ${Math.random().toString(36).slice(2, 8)}`,
    contactName: 'Casey Target',
    contactEmail: email,
  });
  if (!created.ok) throw new Error(created.error);

  const enrolment = await enrollInOpenCampaign(user.userId, created.prospect.id);

  const draft = await createDraft({
    userId: user.userId,
    prospectId: created.prospect.id,
    templateId: enrolment.templateId,
    serviceId: await serviceId(),
    personalization: PERSONALIZATION,
    campaignMemberId: enrolment.memberId,
    campaignStepId: enrolment.stepId,
  });
  if (!draft.ok) throw new Error(draft.error);

  await approveDraft(user.userId, draft.message.id, user.userId);

  return { prospectId: created.prospect.id, messageId: draft.message.id, ...enrolment, email };
}

describe('§66.2 — never send to a suppressed contact', () => {
  it('blocks a send when the contact is suppressed after approval', async () => {
    const ready = await readyToSend();

    await addSuppression({
      userId: user.userId,
      email: ready.email,
      reason: 'DO_NOT_CONTACT',
      note: 'Asked not to be contacted.',
    });

    const result = await sendMessage(ready.messageId);
    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') expect(result.reason).toBe('CONTACT_SUPPRESSED');
    expect(getMockSentMessages()).toHaveLength(0);
  });

  it('blocks a send when the whole domain is suppressed', async () => {
    const ready = await readyToSend('someone@blocked-domain.example');

    await addSuppression({
      userId: user.userId,
      domain: 'blocked-domain.example',
      reason: 'MANUAL_BLOCK',
    });

    const result = await sendMessage(ready.messageId);
    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') expect(result.reason).toBe('DOMAIN_SUPPRESSED');
  });

  it('refuses to even draft to a suppressed address', async () => {
    const created = await createProspect({
      userId: user.userId,
      companyName: 'Suppressed Co',
      contactName: 'No Contact',
      contactEmail: 'no@suppressed-co.example',
    });
    if (!created.ok) throw new Error(created.error);

    const enrolment = await enrollInOpenCampaign(user.userId, created.prospect.id);
    await addSuppression({ userId: user.userId, email: 'no@suppressed-co.example', reason: 'UNSUBSCRIBED' });

    const draft = await createDraft({
      userId: user.userId,
      prospectId: created.prospect.id,
      templateId: enrolment.templateId,
      serviceId: await serviceId(),
      personalization: PERSONALIZATION,
    });
    expect(draft.ok).toBe(false);
  });

  it('treats an address that cannot be normalised as suppressed', async () => {
    const check = await checkSuppression(user.userId, 'not an email');
    expect(check.emailSuppressed).toBe(true);
    expect(check.reason).toBe('INVALID');
  });

  it('stops an active sequence the moment a contact is suppressed', async () => {
    const ready = await readyToSend('stopme@seq-co.example');

    await addSuppression({ userId: user.userId, email: ready.email, reason: 'BOUNCED' });

    const member = await getDb()
      .select()
      .from(campaignMembers)
      .where(eq(campaignMembers.id, ready.memberId));
    expect(member[0]?.status).toBe('STOPPED');
  });

  it('never allows an unsubscribe to be reversed', async () => {
    await addSuppression({ userId: user.userId, email: 'gone@example.com', reason: 'UNSUBSCRIBED' });
    const rows = await getDb()
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.userId, user.userId));

    const result = await removeSuppression(user.userId, rows[0]!.id, user.userId, 'changed my mind');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cannot be reversed');
  });

  it('allows removing a non-unsubscribe suppression, with an audited reason', async () => {
    await addSuppression({ userId: user.userId, email: 'typo@example.com', reason: 'INVALID' });
    const rows = await getDb()
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.userId, user.userId));

    expect((await removeSuppression(user.userId, rows[0]!.id, user.userId, '')).ok).toBe(false);
    expect((await removeSuppression(user.userId, rows[0]!.id, user.userId, 'address was mistyped')).ok).toBe(true);
  });
});

describe('§66.5 — never continue a sequence after a reply', () => {
  it('blocks a queued send when a reply arrives first', async () => {
    const ready = await readyToSend('replier@reply-co.example');

    await recordManualReply({
      userId: user.userId,
      prospectId: ready.prospectId,
      bodyText: 'Not right now, thanks.',
    });

    const result = await sendMessage(ready.messageId);
    expect(result.status).toBe('BLOCKED');
    // Either guard is correct here; both mean the sequence is over.
    if (result.status === 'BLOCKED') {
      expect(['REPLY_RECEIVED', 'SEQUENCE_STOPPED']).toContain(result.reason);
    }
    expect(getMockSentMessages()).toHaveLength(0);
  });

  it('cancels queued messages when a sequence stops', async () => {
    const ready = await readyToSend('cancelme@stop-co.example');

    await stopSequence(user.userId, ready.prospectId, 'MANUALLY_REMOVED', 'Removed by operator.');

    const message = await getDb().select().from(messages).where(eq(messages.id, ready.messageId));
    expect(message[0]?.status).toBe('CANCELLED');
  });
});

describe('§66.6/7 — limits and windows', () => {
  it('blocks when the daily limit is reached', async () => {
    await getDb()
      .update(settings)
      .set({ dailySendLimit: 0 })
      .where(eq(settings.userId, user.userId));

    const ready = await readyToSend('limited@limit-co.example');
    const result = await sendMessage(ready.messageId);

    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') {
      expect(result.reason).toBe('RATE_LIMITED');
      // Transient: it will send tomorrow, so the job defers rather than fails.
      expect(result.transient).toBe(true);
    }
  });

  it('blocks outside the campaign sending window', async () => {
    const ready = await readyToSend('outofhours@window-co.example');

    // Narrow the campaign to a window that cannot contain "now".
    const { campaigns } = await import('../../src/db/schema.js');
    await getDb()
      .update(campaigns)
      .set({ sendingWindows: [{ start: '03:00', end: '03:01' }], sendDays: [1] })
      .where(eq(campaigns.id, ready.campaignId));

    const result = await sendMessage(ready.messageId, new Date('2025-06-04T20:00:00Z'));
    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') expect(result.reason).toBe('OUTSIDE_SENDING_WINDOW');
  });
});

describe('§66.14 — the global pause stops queued work', () => {
  it('blocks an already-approved, already-queued message', async () => {
    const ready = await readyToSend('paused@pause-co.example');

    await enqueue({
      kind: 'SEND_MESSAGE',
      payload: { messageId: ready.messageId },
      dedupeKey: `send:${ready.messageId}`,
    });

    await setGlobalPause(user.userId, true, 'investigating deliverability');

    await runOnce({ workerId: 'test-worker', batchSize: 10 });

    expect(getMockSentMessages()).toHaveLength(0);

    const message = await getDb().select().from(messages).where(eq(messages.id, ready.messageId));
    expect(message[0]?.status).not.toBe('SENT');
    expect(message[0]?.blockedReason).toContain('GLOBAL_PAUSE');
  });

  it('resumes sending after the pause is lifted', async () => {
    const ready = await readyToSend('resumed@resume-co.example');
    await setGlobalPause(user.userId, true, 'temporary');
    expect((await sendMessage(ready.messageId)).status).toBe('BLOCKED');

    await setGlobalPause(user.userId, false, 'all clear');
    // Pausing also pauses campaigns, so the campaign must be restarted too —
    // resuming is deliberately a two-step act, not one flag flip.
    await setCampaignStatus(user.userId, ready.campaignId, 'RUNNING');

    expect((await sendMessage(ready.messageId)).status).toBe('SENT');
  });
});

describe('§66.4 / §32 — idempotency', () => {
  it('sends exactly once even when sendMessage is called repeatedly', async () => {
    const ready = await readyToSend('once@idem-co.example');

    const first = await sendMessage(ready.messageId);
    expect(first.status).toBe('SENT');

    const second = await sendMessage(ready.messageId);
    expect(second.status).toBe('BLOCKED');
    if (second.status === 'BLOCKED') expect(second.reason).toBe('MESSAGE_ALREADY_PROCESSED');

    const third = await sendMessage(ready.messageId);
    expect(third.status).toBe('BLOCKED');

    expect(getMockSentMessages()).toHaveLength(1);

    const attempts = await getDb()
      .select()
      .from(messageAttempts)
      .where(eq(messageAttempts.messageId, ready.messageId));
    expect(attempts.filter((a) => a.status === 'SUCCEEDED')).toHaveLength(1);
  });

  it('sends once when two workers race the same message', async () => {
    const ready = await readyToSend('race@idem-co.example');

    const results = await Promise.all([
      sendMessage(ready.messageId),
      sendMessage(ready.messageId),
      sendMessage(ready.messageId),
    ]);

    // Exactly one worker wins the row lock and the attempt claim. The others
    // are refused outright rather than relying on the provider to deduplicate.
    expect(results.filter((r) => r.status === 'SENT')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'BLOCKED')).toHaveLength(2);
    expect(getMockSentMessages()).toHaveLength(1);
  });

  it('reuses the in-flight attempt after a crash, so the provider deduplicates', async () => {
    const ready = await readyToSend('crash@idem-co.example');

    // Simulate a worker that died between the provider call and recording the
    // outcome: an attempt row exists in STARTED and the message says SENDING.
    const { idempotencyKey } = await import('../../src/lib/crypto.js');
    await getDb().insert(messageAttempts).values({
      messageId: ready.messageId,
      attemptNumber: 1,
      idempotencyKey: idempotencyKey(ready.messageId, 1),
      status: 'STARTED',
      provider: 'mock',
      // Older than the visibility timeout, so this reads as a dead worker
      // rather than a concurrent one.
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await getDb()
      .update(messages)
      .set({ status: 'SENDING' })
      .where(eq(messages.id, ready.messageId));

    const result = await sendMessage(ready.messageId);
    expect(result.status).toBe('SENT');

    // The recovery reused attempt 1 rather than minting attempt 2.
    const attempts = await getDb()
      .select()
      .from(messageAttempts)
      .where(eq(messageAttempts.messageId, ready.messageId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptNumber).toBe(1);
  });

  it('refuses to enqueue the same send twice', async () => {
    const ready = await readyToSend('dedupe@idem-co.example');

    const first = await enqueue({
      kind: 'SEND_MESSAGE',
      payload: { messageId: ready.messageId },
      dedupeKey: `send:${ready.messageId}`,
    });
    const second = await enqueue({
      kind: 'SEND_MESSAGE',
      payload: { messageId: ready.messageId },
      dedupeKey: `send:${ready.messageId}`,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const queued = await getDb().select().from(jobs).where(eq(jobs.kind, 'SEND_MESSAGE'));
    expect(queued).toHaveLength(1);
  });

  it('prevents a second message for the same sequence step at the database level', async () => {
    const ready = await readyToSend('step@idem-co.example');

    await expect(
      getDb().insert(messages).values({
        userId: user.userId,
        prospectId: ready.prospectId,
        contactId: (
          await getDb().select().from(prospects).where(eq(prospects.id, ready.prospectId))
        )[0]!.contactId,
        campaignMemberId: ready.memberId,
        campaignStepId: ready.stepId,
        toEmail: ready.email,
        subject: 'Duplicate step message',
        bodyText: 'This should be rejected by the unique index.',
        contentHash: 'whatever',
      }),
    ).rejects.toThrow();
  });
});

describe('provider failures', () => {
  it('records a permanent failure without retrying', async () => {
    addMockFailure({
      permanent: true,
      errorCode: 'INVALID_RECIPIENT',
      errorMessage: 'Mailbox does not exist.',
    });

    const ready = await readyToSend('bad@fail-co.example');
    const result = await sendMessage(ready.messageId);

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.permanent).toBe(true);

    const message = await getDb().select().from(messages).where(eq(messages.id, ready.messageId));
    expect(message[0]?.status).toBe('FAILED');
  });

  it('returns a transient failure to APPROVED so the queue can retry', async () => {
    addMockFailure({ permanent: false, errorCode: 'HTTP_503', errorMessage: 'Upstream unavailable.' });

    const ready = await readyToSend('flaky@fail-co.example');
    const result = await sendMessage(ready.messageId);

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.permanent).toBe(false);

    const message = await getDb().select().from(messages).where(eq(messages.id, ready.messageId));
    expect(message[0]?.status).toBe('APPROVED');
  });

  it('stops retrying a job once max_attempts is exhausted', async () => {
    const job = await enqueue({ kind: 'SEND_MESSAGE', payload: { messageId: 'nope' }, maxAttempts: 2 });
    expect(job).not.toBeNull();

    let claimed = await claimJobs('w1', 1);
    await failJob(claimed[0]!, 'first failure');
    let row = await getDb().select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row[0]?.status).toBe('PENDING');

    // Force it due again, then exhaust the second attempt.
    await getDb().update(jobs).set({ runAfter: new Date() }).where(eq(jobs.id, job!.id));
    claimed = await claimJobs('w1', 1);
    await failJob(claimed[0]!, 'second failure');

    row = await getDb().select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row[0]?.status).toBe('FAILED');
  });
});

describe('unsubscribe', () => {
  it('suppresses immediately and synchronously, and stops the sequence', async () => {
    const ready = await readyToSend('unsub@unsub-co.example');

    const tokenRows = await getDb().select().from(unsubscribeTokens);
    expect(tokenRows.length).toBeGreaterThan(0);

    // The raw token is only in the emailed link; recompute its hash the same way.
    const rawToken = 'test-token-value';
    await getDb()
      .update(unsubscribeTokens)
      .set({ tokenHash: sha256(rawToken) })
      .where(eq(unsubscribeTokens.id, tokenRows[0]!.id));

    const result = await processUnsubscribe(sha256(rawToken));
    expect(result.ok).toBe(true);

    const suppression = await checkSuppression(user.userId, ready.email);
    expect(suppression.emailSuppressed).toBe(true);
    expect(suppression.reason).toBe('UNSUBSCRIBED');

    const member = await getDb()
      .select()
      .from(campaignMembers)
      .where(eq(campaignMembers.id, ready.memberId));
    expect(member[0]?.status).toBe('STOPPED');

    expect((await sendMessage(ready.messageId)).status).toBe('BLOCKED');
  });

  it('remains usable after first use, and rejects an unknown token', async () => {
    const ready = await readyToSend('twice@unsub-co.example');
    const tokenRows = await getDb().select().from(unsubscribeTokens);
    const raw = 'reusable-token';
    await getDb()
      .update(unsubscribeTokens)
      .set({ tokenHash: sha256(raw) })
      .where(eq(unsubscribeTokens.id, tokenRows[0]!.id));

    expect((await processUnsubscribe(sha256(raw))).ok).toBe(true);
    // CAN-SPAM requires the mechanism to keep working; re-confirming must not error.
    const second = await processUnsubscribe(sha256(raw));
    expect(second.ok).toBe(true);
    expect(second.alreadyDone).toBe(true);

    expect((await processUnsubscribe(sha256('never-issued'))).ok).toBe(false);
    expect(ready.email).toBeTruthy();
  });
});

describe('deletion never removes suppression', () => {
  it('keeps the suppression row after the prospect and contact are deleted', async () => {
    const ready = await readyToSend('deleteme@delete-co.example');

    await addSuppression({
      userId: user.userId,
      email: ready.email,
      reason: 'UNSUBSCRIBED',
      note: 'Unsubscribed before deletion.',
    });

    const result = await deleteProspect(user.userId, ready.prospectId, {
      deleteContact: true,
      deleteCompanyIfOrphaned: true,
    });
    expect(result.ok).toBe(true);
    expect(result.suppressionPreserved).toBe(true);

    // The prospect is gone.
    const remaining = await getDb()
      .select()
      .from(prospects)
      .where(eq(prospects.id, ready.prospectId));
    expect(remaining).toHaveLength(0);

    // The suppression is not. Re-importing this person must not make them
    // contactable again.
    const suppression = await checkSuppression(user.userId, ready.email);
    expect(suppression.emailSuppressed).toBe(true);
    expect(suppression.reason).toBe('UNSUBSCRIBED');

    const recreated = await createProspect({
      userId: user.userId,
      companyName: 'Delete Co',
      contactName: 'Deleted Person',
      contactEmail: ready.email,
    });
    expect(recreated.ok).toBe(true);
    if (recreated.ok) {
      const stillSuppressed = await checkSuppression(user.userId, ready.email);
      expect(stillSuppressed.emailSuppressed).toBe(true);
    }
  });

  it('does not invent a suppression for a prospect that never had one', async () => {
    const ready = await readyToSend('nosupp@delete-co.example');
    const result = await deleteProspect(user.userId, ready.prospectId, { deleteContact: true });

    expect(result.ok).toBe(true);
    expect(result.suppressionPreserved).toBe(false);

    const rows = await getDb()
      .select()
      .from(suppressionList)
      .where(and(eq(suppressionList.userId, user.userId)));
    expect(rows).toHaveLength(0);
  });
});
