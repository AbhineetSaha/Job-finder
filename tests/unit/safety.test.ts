/**
 * Tests for the send preflight gate.
 *
 * The last block in this file answers each question from brief §70 directly.
 * If any of those tests fail, the system can send an email it should not.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSnapshotComplete,
  evaluateSendPreflight,
  isTransientBlock,
  type SendPreflightSnapshot,
} from '../../src/domain/safety.js';

const NOW = new Date('2025-06-02T15:00:00Z');

/** A snapshot in which every condition passes. Tests break exactly one thing. */
function validSnapshot(overrides: Partial<SendPreflightSnapshot> = {}): SendPreflightSnapshot {
  return {
    globalSendPaused: false,
    prospectExists: true,
    prospectStatus: 'APPROVED',
    recipientEmail: 'dana@northwind.example',
    recipientEmailValid: true,
    recipientSuppressed: false,
    recipientDomainSuppressed: false,
    messageStatus: 'APPROVED',
    currentContentHash: 'hash-abc',
    approvalExists: true,
    approvalRevoked: false,
    approvedContentHash: 'hash-abc',
    alreadySentForStep: false,
    alreadyDispatched: false,
    campaignStatus: 'RUNNING',
    campaignMemberStatus: 'ACTIVE',
    hasReply: false,
    windowAllowed: true,
    windowDetail: 'Inside 09:00–11:30.',
    rateLimitAllowed: true,
    rateLimitDetail: 'Within all configured limits.',
    postalAddressConfigured: true,
    providerConfigured: true,
    scheduledAt: new Date('2025-06-02T14:00:00Z'),
    now: NOW,
    ...overrides,
  };
}

describe('evaluateSendPreflight — the happy path', () => {
  it('allows a send only when every condition passes', () => {
    expect(evaluateSendPreflight(validSnapshot()).ok).toBe(true);
  });

  it('allows a one-off message with no campaign', () => {
    const result = evaluateSendPreflight(
      validSnapshot({ campaignStatus: null, campaignMemberStatus: null }),
    );
    expect(result.ok).toBe(true);
  });

  it('allows a message with no explicit schedule', () => {
    expect(evaluateSendPreflight(validSnapshot({ scheduledAt: null })).ok).toBe(true);
  });
});

describe('evaluateSendPreflight — fails closed on incomplete input', () => {
  it('blocks when the snapshot is null or not an object', () => {
    expect(evaluateSendPreflight(null)).toMatchObject({ ok: false, reason: 'SNAPSHOT_INCOMPLETE' });
    expect(evaluateSendPreflight(undefined)).toMatchObject({ ok: false, reason: 'SNAPSHOT_INCOMPLETE' });
    expect(evaluateSendPreflight({})).toMatchObject({ ok: false, reason: 'SNAPSHOT_INCOMPLETE' });
  });

  it('blocks when ANY single field could not be determined', () => {
    const keys = Object.keys(validSnapshot()) as (keyof SendPreflightSnapshot)[];
    for (const key of keys) {
      const partial: Partial<SendPreflightSnapshot> = validSnapshot();
      delete partial[key];
      const result = evaluateSendPreflight(partial);
      expect(result.ok, `omitting "${key}" must block the send`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('SNAPSHOT_INCOMPLETE');
    }
  });

  it('blocks when a non-nullable field is explicitly null', () => {
    const result = evaluateSendPreflight(
      validSnapshot({ recipientSuppressed: null as unknown as boolean }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'SNAPSHOT_INCOMPLETE' });
  });

  it('accepts null for the fields that are legitimately nullable', () => {
    const check = assertSnapshotComplete(
      validSnapshot({
        approvedContentHash: null,
        campaignStatus: null,
        campaignMemberStatus: null,
        scheduledAt: null,
      }),
    );
    expect(check.ok).toBe(true);
  });
});

describe('evaluateSendPreflight — each individual guard', () => {
  const cases: [string, Partial<SendPreflightSnapshot>, string][] = [
    ['global pause', { globalSendPaused: true }, 'GLOBAL_PAUSE'],
    ['missing prospect', { prospectExists: false }, 'PROSPECT_MISSING'],
    ['suppressed contact', { recipientSuppressed: true }, 'CONTACT_SUPPRESSED'],
    ['suppressed domain', { recipientDomainSuppressed: true }, 'DOMAIN_SUPPRESSED'],
    ['uncontactable status', { prospectStatus: 'DO_NOT_CONTACT' }, 'PROSPECT_NOT_CONTACTABLE'],
    ['reply received', { hasReply: true }, 'REPLY_RECEIVED'],
    ['invalid recipient', { recipientEmailValid: false }, 'INVALID_RECIPIENT'],
    ['already dispatched', { alreadyDispatched: true }, 'MESSAGE_ALREADY_PROCESSED'],
    ['duplicate for step', { alreadySentForStep: true }, 'DUPLICATE_FOR_STEP'],
    ['unapproved status', { messageStatus: 'DRAFT' }, 'MESSAGE_NOT_APPROVED'],
    ['pending approval', { messageStatus: 'PENDING_APPROVAL' }, 'MESSAGE_NOT_APPROVED'],
    ['no approval record', { approvalExists: false }, 'APPROVAL_MISSING'],
    ['revoked approval', { approvalRevoked: true }, 'APPROVAL_REVOKED'],
    ['stale approval', { approvedContentHash: 'different-hash' }, 'APPROVAL_STALE'],
    ['null approved hash', { approvedContentHash: null }, 'APPROVAL_STALE'],
    ['paused campaign', { campaignStatus: 'PAUSED' }, 'CAMPAIGN_NOT_RUNNING'],
    ['draft campaign', { campaignStatus: 'DRAFT' }, 'CAMPAIGN_NOT_RUNNING'],
    ['stopped enrolment', { campaignMemberStatus: 'STOPPED' }, 'SEQUENCE_STOPPED'],
    ['completed enrolment', { campaignMemberStatus: 'COMPLETED' }, 'SEQUENCE_STOPPED'],
    ['outside window', { windowAllowed: false }, 'OUTSIDE_SENDING_WINDOW'],
    ['rate limited', { rateLimitAllowed: false }, 'RATE_LIMITED'],
    ['no postal address', { postalAddressConfigured: false }, 'MISSING_POSTAL_ADDRESS'],
    ['provider unconfigured', { providerConfigured: false }, 'PROVIDER_NOT_CONFIGURED'],
    [
      'scheduled in the future',
      { scheduledAt: new Date('2025-06-02T16:00:00Z') },
      'SCHEDULED_IN_FUTURE',
    ],
  ];

  for (const [name, override, expectedReason] of cases) {
    it(`blocks on ${name}`, () => {
      const result = evaluateSendPreflight(validSnapshot(override));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(expectedReason);
    });
  }

  it('blocks a recipient address containing a line break', () => {
    const result = evaluateSendPreflight(
      validSnapshot({ recipientEmail: 'a@b.com\r\nBcc: evil@x.com' }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'INVALID_RECIPIENT' });
  });
});

describe('block classification', () => {
  it('treats "not yet" conditions as transient and everything else as permanent', () => {
    for (const reason of [
      'GLOBAL_PAUSE',
      'OUTSIDE_SENDING_WINDOW',
      'RATE_LIMITED',
      'SCHEDULED_IN_FUTURE',
      'CAMPAIGN_NOT_RUNNING',
      'MISSING_POSTAL_ADDRESS',
      'PROVIDER_NOT_CONFIGURED',
    ] as const) {
      expect(isTransientBlock(reason), reason).toBe(true);
    }

    for (const reason of [
      'CONTACT_SUPPRESSED',
      'DOMAIN_SUPPRESSED',
      'APPROVAL_STALE',
      'APPROVAL_MISSING',
      'REPLY_RECEIVED',
      'DUPLICATE_FOR_STEP',
      'MESSAGE_ALREADY_PROCESSED',
      'SNAPSHOT_INCOMPLETE',
      'INVALID_RECIPIENT',
    ] as const) {
      expect(isTransientBlock(reason), reason).toBe(false);
    }
  });
});

/**
 * Brief §70 — the outreach safety review, as executable assertions.
 * Every question must answer "no".
 */
describe('§70 outreach safety review', () => {
  it('Q: can a prospect receive two identical emails accidentally? A: no', () => {
    expect(evaluateSendPreflight(validSnapshot({ alreadySentForStep: true })).ok).toBe(false);
    expect(evaluateSendPreflight(validSnapshot({ alreadyDispatched: true })).ok).toBe(false);
  });

  it('Q: can a suppressed contact receive an email? A: no', () => {
    expect(evaluateSendPreflight(validSnapshot({ recipientSuppressed: true })).ok).toBe(false);
    expect(evaluateSendPreflight(validSnapshot({ recipientDomainSuppressed: true })).ok).toBe(false);
    // Even with everything else in order and the campaign running.
    expect(
      evaluateSendPreflight(
        validSnapshot({ recipientSuppressed: true, campaignStatus: 'RUNNING', hasReply: false }),
      ).ok,
    ).toBe(false);
  });

  it('Q: can a reply fail to stop a sequence? A: no', () => {
    // Even if the enrolment row still says ACTIVE — e.g. a reply that landed
    // after the job was queued — the reply itself blocks the send.
    expect(
      evaluateSendPreflight(validSnapshot({ hasReply: true, campaignMemberStatus: 'ACTIVE' })).ok,
    ).toBe(false);
  });

  it('Q: can a paused campaign still send? A: no', () => {
    expect(evaluateSendPreflight(validSnapshot({ campaignStatus: 'PAUSED' })).ok).toBe(false);
    expect(evaluateSendPreflight(validSnapshot({ globalSendPaused: true })).ok).toBe(false);
  });

  it('Q: can a worker retry a message twice? A: no', () => {
    expect(evaluateSendPreflight(validSnapshot({ alreadyDispatched: true })).ok).toBe(false);
  });

  it('Q: can an unapproved email reach the provider? A: no', () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'CANCELLED', 'BLOCKED', 'FAILED']) {
      expect(evaluateSendPreflight(validSnapshot({ messageStatus: status })).ok, status).toBe(false);
    }
    expect(evaluateSendPreflight(validSnapshot({ approvalExists: false })).ok).toBe(false);
  });

  it('Q: can an email edited after approval be sent? A: no', () => {
    expect(
      evaluateSendPreflight(
        validSnapshot({ currentContentHash: 'edited', approvedContentHash: 'original' }),
      ).ok,
    ).toBe(false);
  });

  it('Q: can a send happen when a safety condition is unverifiable? A: no', () => {
    const partial: Partial<SendPreflightSnapshot> = validSnapshot();
    delete partial.recipientSuppressed;
    expect(evaluateSendPreflight(partial).ok).toBe(false);
  });

  it('Q: can a send happen without the CAN-SPAM postal address? A: no', () => {
    expect(evaluateSendPreflight(validSnapshot({ postalAddressConfigured: false })).ok).toBe(false);
  });
});
