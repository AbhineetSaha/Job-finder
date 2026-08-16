/**
 * Prospect status state machine. Pure, no I/O.
 *
 * Transitions are explicit so that "how did this prospect get to WON?" is
 * answerable from the activity timeline, and so that an accidental jump (e.g.
 * DISCOVERED → CONTACTED, skipping approval) is rejected rather than recorded.
 */

export const PROSPECT_STATUSES = [
  'DISCOVERED',
  'RESEARCHING',
  'QUALIFIED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'CONTACTED',
  'FOLLOW_UP_1',
  'FOLLOW_UP_2',
  'REPLIED',
  'MEETING_BOOKED',
  'PROPOSAL_SENT',
  'NEGOTIATION',
  'WON',
  'LOST',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
  'INVALID',
  'BOUNCED',
] as const;

export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

/**
 * Statuses reachable from anywhere. These are outcomes, not stages: a prospect
 * can turn out to be uninterested or invalid at any point.
 */
const TERMINAL_FROM_ANYWHERE: ProspectStatus[] = [
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
  'INVALID',
  'BOUNCED',
  'LOST',
];

/** Statuses from which no further outbound contact may originate. */
const NO_CONTACT_STATUSES = new Set<ProspectStatus>([
  'DO_NOT_CONTACT',
  'NOT_INTERESTED',
  'INVALID',
  'BOUNCED',
  'WON',
  'LOST',
]);

const TRANSITIONS: Record<ProspectStatus, ProspectStatus[]> = {
  DISCOVERED: ['RESEARCHING', 'QUALIFIED'],
  RESEARCHING: ['QUALIFIED', 'READY_FOR_REVIEW', 'DISCOVERED'],
  QUALIFIED: ['READY_FOR_REVIEW', 'RESEARCHING'],
  READY_FOR_REVIEW: ['APPROVED', 'RESEARCHING', 'QUALIFIED'],
  APPROVED: ['CONTACTED', 'READY_FOR_REVIEW'],
  CONTACTED: ['FOLLOW_UP_1', 'REPLIED', 'MEETING_BOOKED'],
  FOLLOW_UP_1: ['FOLLOW_UP_2', 'REPLIED', 'MEETING_BOOKED'],
  FOLLOW_UP_2: ['REPLIED', 'MEETING_BOOKED'],
  REPLIED: ['MEETING_BOOKED', 'PROPOSAL_SENT', 'NEGOTIATION'],
  MEETING_BOOKED: ['PROPOSAL_SENT', 'NEGOTIATION', 'REPLIED'],
  PROPOSAL_SENT: ['NEGOTIATION', 'WON'],
  NEGOTIATION: ['WON', 'PROPOSAL_SENT'],
  // Outcomes. Reopening is deliberate and narrow.
  WON: [],
  LOST: ['RESEARCHING'],
  NOT_INTERESTED: [],
  DO_NOT_CONTACT: [],
  INVALID: ['RESEARCHING'],
  BOUNCED: ['RESEARCHING'],
};

export interface TransitionResult {
  allowed: boolean;
  reason: string;
}

export function canTransition(from: ProspectStatus, to: ProspectStatus): TransitionResult {
  if (from === to) {
    return { allowed: false, reason: `Prospect is already ${to}.` };
  }

  // DO_NOT_CONTACT is a one-way door: once set, only an explicit suppression
  // removal (a separate, audited action) can change the outcome.
  if (from === 'DO_NOT_CONTACT') {
    return {
      allowed: false,
      reason: 'DO_NOT_CONTACT is final. Remove the suppression entry explicitly to re-engage.',
    };
  }

  if (TERMINAL_FROM_ANYWHERE.includes(to)) {
    return { allowed: true, reason: `${to} may be set from any status.` };
  }

  const permitted = TRANSITIONS[from];
  if (permitted.includes(to)) {
    return { allowed: true, reason: `${from} → ${to} is a permitted transition.` };
  }

  return {
    allowed: false,
    reason: `${from} → ${to} is not a permitted transition. Allowed: ${
      permitted.length ? permitted.join(', ') : 'none'
    }.`,
  };
}

export function allowedTransitions(from: ProspectStatus): ProspectStatus[] {
  const base = TRANSITIONS[from];
  if (from === 'DO_NOT_CONTACT') return [];
  return [...new Set([...base, ...TERMINAL_FROM_ANYWHERE])].filter((s) => s !== from);
}

/** Whether any further outbound email may be sent to a prospect in this status. */
export function isContactable(status: ProspectStatus): boolean {
  return !NO_CONTACT_STATUSES.has(status);
}

/** The status a prospect moves to after a successful send at a given sequence position. */
export function statusAfterSend(position: number): ProspectStatus {
  if (position <= 0) return 'CONTACTED';
  if (position === 1) return 'FOLLOW_UP_1';
  return 'FOLLOW_UP_2';
}

/* -------------------------------------------------------------------------- */
/* CRM pipeline mapping                                                       */
/* -------------------------------------------------------------------------- */

export const PIPELINE_STAGES = [
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'REPLIED',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Collapse the 18 detailed statuses onto the 9-column board (brief §36). */
export function pipelineStage(status: ProspectStatus): PipelineStage {
  switch (status) {
    case 'DISCOVERED':
    case 'RESEARCHING':
      return 'NEW';
    case 'QUALIFIED':
    case 'READY_FOR_REVIEW':
    case 'APPROVED':
      return 'QUALIFIED';
    case 'CONTACTED':
    case 'FOLLOW_UP_1':
    case 'FOLLOW_UP_2':
      return 'CONTACTED';
    case 'REPLIED':
      return 'REPLIED';
    case 'MEETING_BOOKED':
      return 'MEETING';
    case 'PROPOSAL_SENT':
      return 'PROPOSAL';
    case 'NEGOTIATION':
      return 'NEGOTIATION';
    case 'WON':
      return 'WON';
    case 'LOST':
    case 'NOT_INTERESTED':
    case 'DO_NOT_CONTACT':
    case 'INVALID':
    case 'BOUNCED':
      return 'LOST';
  }
}

export function statusLabel(status: ProspectStatus): string {
  return status
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}
