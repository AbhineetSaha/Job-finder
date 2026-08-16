/**
 * The send preflight gate. Pure, no I/O.
 *
 * This is the single place where the question "may this specific email be sent
 * right now?" is answered. The worker calls it inside the send transaction,
 * immediately before handing anything to a provider, having re-read every
 * input from the database — the UI's earlier validation is never trusted
 * (brief §31).
 *
 * Two properties make this trustworthy:
 *
 *  1. There is no default-allow branch. The function is a list of guards, and
 *     the final `return ALLOWED` is reached only after every one has passed.
 *  2. Every field of the snapshot is required and is verified present at
 *     runtime by `assertSnapshotComplete`. A value the caller could not
 *     determine cannot be quietly omitted — an absent field blocks the send
 *     with SNAPSHOT_INCOMPLETE (brief §66.15).
 */
import type { ProspectStatus } from './status.js';
import { isContactable } from './status.js';

export type BlockReason =
  | 'SNAPSHOT_INCOMPLETE'
  | 'GLOBAL_PAUSE'
  | 'PROSPECT_MISSING'
  | 'PROSPECT_NOT_CONTACTABLE'
  | 'INVALID_RECIPIENT'
  | 'CONTACT_SUPPRESSED'
  | 'DOMAIN_SUPPRESSED'
  | 'MESSAGE_NOT_APPROVED'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_STALE'
  | 'MESSAGE_ALREADY_PROCESSED'
  | 'DUPLICATE_FOR_STEP'
  | 'CAMPAIGN_NOT_RUNNING'
  | 'SEQUENCE_STOPPED'
  | 'REPLY_RECEIVED'
  | 'OUTSIDE_SENDING_WINDOW'
  | 'RATE_LIMITED'
  | 'MISSING_POSTAL_ADDRESS'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'SCHEDULED_IN_FUTURE';

export interface SendPreflightSnapshot {
  /** Global kill switch, re-read per job so a pause stops queued work. */
  globalSendPaused: boolean;

  prospectExists: boolean;
  prospectStatus: ProspectStatus;

  /** Recipient address exactly as it will be handed to the provider. */
  recipientEmail: string;
  recipientEmailValid: boolean;
  recipientSuppressed: boolean;
  recipientDomainSuppressed: boolean;

  messageStatus: string;
  /** Hash of the message content as it exists NOW. */
  currentContentHash: string;

  approvalExists: boolean;
  approvalRevoked: boolean;
  /** Hash the operator actually approved. */
  approvedContentHash: string | null;

  /** True when a message for this campaign step has already been sent. */
  alreadySentForStep: boolean;
  /** True when a previous attempt already reached the provider successfully. */
  alreadyDispatched: boolean;

  /** Null for a one-off message outside any campaign. */
  campaignStatus: string | null;
  campaignMemberStatus: string | null;

  /** Any reply from this contact stops the sequence, whenever it arrived. */
  hasReply: boolean;

  windowAllowed: boolean;
  windowDetail: string;

  rateLimitAllowed: boolean;
  rateLimitDetail: string;

  /** CAN-SPAM requires a valid physical postal address in every message. */
  postalAddressConfigured: boolean;
  providerConfigured: boolean;

  scheduledAt: Date | null;
  now: Date;
}

export interface PreflightAllowed {
  ok: true;
}

export interface PreflightBlocked {
  ok: false;
  reason: BlockReason;
  detail: string;
}

export type PreflightResult = PreflightAllowed | PreflightBlocked;

const ALLOWED: PreflightAllowed = { ok: true };

const block = (reason: BlockReason, detail: string): PreflightBlocked => ({
  ok: false,
  reason,
  detail,
});

/** Message statuses from which a send may legitimately proceed. */
const DISPATCHABLE_STATUSES = new Set(['APPROVED', 'SCHEDULED', 'QUEUED', 'SENDING']);

/**
 * Every key of the snapshot, listed explicitly. Adding a field to the
 * interface without adding it here is caught by the type annotation below, so
 * a new safety input cannot be introduced and then silently skipped.
 */
const REQUIRED_KEYS: Record<keyof SendPreflightSnapshot, true> = {
  globalSendPaused: true,
  prospectExists: true,
  prospectStatus: true,
  recipientEmail: true,
  recipientEmailValid: true,
  recipientSuppressed: true,
  recipientDomainSuppressed: true,
  messageStatus: true,
  currentContentHash: true,
  approvalExists: true,
  approvalRevoked: true,
  approvedContentHash: true,
  alreadySentForStep: true,
  alreadyDispatched: true,
  campaignStatus: true,
  campaignMemberStatus: true,
  hasReply: true,
  windowAllowed: true,
  windowDetail: true,
  rateLimitAllowed: true,
  rateLimitDetail: true,
  postalAddressConfigured: true,
  providerConfigured: true,
  scheduledAt: true,
  now: true,
};

/** Keys whose value is legitimately null. Every other key must not be null. */
const NULLABLE_KEYS = new Set<keyof SendPreflightSnapshot>([
  'approvedContentHash',
  'campaignStatus',
  'campaignMemberStatus',
  'scheduledAt',
]);

/**
 * Verify the caller actually determined every input. A field that is absent or
 * undefined means a safety condition could not be verified, which is a block,
 * not a pass.
 */
export function assertSnapshotComplete(
  snapshot: Partial<SendPreflightSnapshot> | null | undefined,
): PreflightResult {
  if (!snapshot || typeof snapshot !== 'object') {
    return block('SNAPSHOT_INCOMPLETE', 'No send context could be assembled.');
  }

  const missing: string[] = [];
  for (const key of Object.keys(REQUIRED_KEYS) as (keyof SendPreflightSnapshot)[]) {
    const value = snapshot[key];
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    if (value === null && !NULLABLE_KEYS.has(key)) missing.push(key);
  }

  if (missing.length > 0) {
    return block(
      'SNAPSHOT_INCOMPLETE',
      `Could not verify: ${missing.join(', ')}. Refusing to send when a safety condition is unknown.`,
    );
  }

  return ALLOWED;
}

/**
 * Decide whether one specific email may be sent right now.
 *
 * Order matters only for the quality of the reported reason, not for
 * correctness — every guard must pass. The most consequential and most
 * absolute rules are checked first so the recorded reason is the most
 * meaningful one.
 */
export function evaluateSendPreflight(
  input: Partial<SendPreflightSnapshot> | null | undefined,
): PreflightResult {
  const completeness = assertSnapshotComplete(input);
  if (!completeness.ok) return completeness;

  const s = input as SendPreflightSnapshot;

  // 1. Global kill switch. Re-read per job, so pausing stops queued work too.
  if (s.globalSendPaused) {
    return block('GLOBAL_PAUSE', 'All sending is globally paused.');
  }

  // 2. The prospect must still exist.
  if (!s.prospectExists) {
    return block('PROSPECT_MISSING', 'The prospect no longer exists.');
  }

  // 3. Suppression. Checked before anything else about the message, because it
  //    is the rule that must hold regardless of any other state.
  if (s.recipientSuppressed) {
    return block(
      'CONTACT_SUPPRESSED',
      `${s.recipientEmail} is on the suppression list and must never receive automated outreach.`,
    );
  }
  if (s.recipientDomainSuppressed) {
    return block(
      'DOMAIN_SUPPRESSED',
      `The recipient's domain is suppressed; no contact at this company may be emailed.`,
    );
  }

  // 4. Prospect status must permit further contact.
  if (!isContactable(s.prospectStatus)) {
    return block(
      'PROSPECT_NOT_CONTACTABLE',
      `Prospect status ${s.prospectStatus} does not permit further outbound email.`,
    );
  }

  // 5. A reply always stops the sequence, whenever it arrived — including
  //    between this job being queued and being claimed.
  if (s.hasReply) {
    return block('REPLY_RECEIVED', 'The contact has replied; the sequence is stopped.');
  }

  // 6. Recipient validity. An invalid address cannot be sent to, and a CR/LF in
  //    it would be a header-injection attempt.
  if (!s.recipientEmailValid || !s.recipientEmail) {
    return block('INVALID_RECIPIENT', `"${s.recipientEmail}" is not a valid recipient address.`);
  }
  if (/[\r\n]/.test(s.recipientEmail)) {
    return block('INVALID_RECIPIENT', 'Recipient address contains a line break.');
  }

  // 7. Duplicate protection.
  if (s.alreadyDispatched) {
    return block(
      'MESSAGE_ALREADY_PROCESSED',
      'A previous attempt for this message already reached the provider.',
    );
  }
  if (s.alreadySentForStep) {
    return block(
      'DUPLICATE_FOR_STEP',
      'A message for this sequence step has already been sent to this prospect.',
    );
  }

  // 8. Human approval, and that the approval still matches the content.
  if (!DISPATCHABLE_STATUSES.has(s.messageStatus)) {
    return block(
      'MESSAGE_NOT_APPROVED',
      `Message status is ${s.messageStatus}; only an approved and scheduled message may be sent.`,
    );
  }
  if (!s.approvalExists) {
    return block('APPROVAL_MISSING', 'No human approval exists for this message.');
  }
  if (s.approvalRevoked) {
    return block('APPROVAL_REVOKED', 'The approval for this message was revoked.');
  }
  if (!s.approvedContentHash || s.approvedContentHash !== s.currentContentHash) {
    return block(
      'APPROVAL_STALE',
      'The message was edited after it was approved. It must be reviewed and approved again.',
    );
  }

  // 9. Campaign and enrolment state.
  if (s.campaignStatus !== null && s.campaignStatus !== 'RUNNING') {
    return block('CAMPAIGN_NOT_RUNNING', `The campaign is ${s.campaignStatus}, not RUNNING.`);
  }
  if (s.campaignMemberStatus !== null && s.campaignMemberStatus !== 'ACTIVE') {
    return block(
      'SEQUENCE_STOPPED',
      `The prospect's enrolment is ${s.campaignMemberStatus}, not ACTIVE.`,
    );
  }

  // 10. Do not send ahead of schedule.
  if (s.scheduledAt !== null && s.scheduledAt.getTime() > s.now.getTime()) {
    return block(
      'SCHEDULED_IN_FUTURE',
      `Scheduled for ${s.scheduledAt.toISOString()}, which is still in the future.`,
    );
  }

  // 11. Sending window and rate limits.
  if (!s.windowAllowed) {
    return block('OUTSIDE_SENDING_WINDOW', s.windowDetail);
  }
  if (!s.rateLimitAllowed) {
    return block('RATE_LIMITED', s.rateLimitDetail);
  }

  // 12. Compliance and provider preconditions.
  if (!s.postalAddressConfigured) {
    return block(
      'MISSING_POSTAL_ADDRESS',
      'No physical postal address is configured. CAN-SPAM requires one in every commercial message.',
    );
  }
  if (!s.providerConfigured) {
    return block('PROVIDER_NOT_CONFIGURED', 'The email provider is not fully configured.');
  }

  return ALLOWED;
}

/** Whether a blocked send should be retried later or abandoned permanently. */
export function isTransientBlock(reason: BlockReason): boolean {
  switch (reason) {
    case 'GLOBAL_PAUSE':
    case 'OUTSIDE_SENDING_WINDOW':
    case 'RATE_LIMITED':
    case 'SCHEDULED_IN_FUTURE':
    case 'CAMPAIGN_NOT_RUNNING':
    case 'MISSING_POSTAL_ADDRESS':
    case 'PROVIDER_NOT_CONFIGURED':
      return true;
    default:
      return false;
  }
}

export function blockReasonLabel(reason: BlockReason): string {
  return reason
    .split('_')
    .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
    .join(' ');
}
