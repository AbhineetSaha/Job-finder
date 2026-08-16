/**
 * Deterministic qualification scoring. Pure, no I/O, no inference.
 *
 * Every signal is tri-state. UNKNOWN scores zero and is recorded as unknown:
 * the engine never fills a gap with an assumption. A prospect with mostly
 * unknown signals scores low, which correctly means "go do the research"
 * rather than "this company is bad" (brief §13).
 */

export const SIGNAL_KEYS = [
  'usCompany',
  'saasOrSoftware',
  'engineeringTeamIdentified',
  'hiringEngineers',
  'contractorSignal',
  'technologyMatch',
  'engineeringNeed',
  'decisionMakerIdentified',
] as const;

export type SignalKey = (typeof SIGNAL_KEYS)[number];

export type SignalValue = 'YES' | 'NO' | 'UNKNOWN';

export type QualificationSignals = Record<SignalKey, SignalValue>;

export type QualificationBand = 'HIGH_PRIORITY' | 'STRONG' | 'POTENTIAL' | 'WEAK' | 'POOR';

export interface QualificationReason {
  code: SignalKey;
  label: string;
  points: number;
  /** Whether the points came from a positive signal, or zero from NO/UNKNOWN. */
  value: SignalValue;
}

export interface QualificationResult {
  score: number;
  band: QualificationBand;
  reasons: QualificationReason[];
  /** Signals the operator has not yet determined. Surfaced as a research to-do. */
  unknownSignals: SignalKey[];
  maxPossibleScore: number;
  weightsVersion: string;
}

/** The §13 weight table. Overridable per user via `settings.qualification_weights`. */
export const DEFAULT_WEIGHTS: Record<SignalKey, number> = {
  usCompany: 20,
  saasOrSoftware: 15,
  engineeringTeamIdentified: 10,
  hiringEngineers: 15,
  contractorSignal: 15,
  technologyMatch: 10,
  engineeringNeed: 10,
  decisionMakerIdentified: 5,
};

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  usCompany: 'US company',
  saasOrSoftware: 'SaaS / software company',
  engineeringTeamIdentified: 'Engineering team identified',
  hiringEngineers: 'Currently hiring engineers',
  contractorSignal: 'Contractor / freelancer signal',
  technologyMatch: 'Technology match',
  engineeringNeed: 'Identifiable engineering need',
  decisionMakerIdentified: 'Decision maker identified',
};

/** Prompts shown next to each signal so the operator knows what evidence counts. */
export const SIGNAL_HELP: Record<SignalKey, string> = {
  usCompany: 'Headquarters or primary operations in the United States.',
  saasOrSoftware: 'Sells software or a software-enabled product, not services resale.',
  engineeringTeamIdentified: 'You can name at least one engineer or see a team page.',
  hiringEngineers: 'A live engineering job posting exists.',
  contractorSignal: 'Evidence they use contractors: contract roles, agency work, fractional staff.',
  technologyMatch: 'Their public stack overlaps yours (Java/Spring, Node, TS, React, Next, Postgres).',
  engineeringNeed: 'A concrete, observable problem you could help with.',
  decisionMakerIdentified: 'A founder, CTO, VP/Head of Engineering or equivalent is identified.',
};

const BANDS: { band: QualificationBand; min: number; label: string }[] = [
  { band: 'HIGH_PRIORITY', min: 90, label: 'High Priority' },
  { band: 'STRONG', min: 75, label: 'Strong' },
  { band: 'POTENTIAL', min: 60, label: 'Potential' },
  { band: 'WEAK', min: 40, label: 'Weak' },
  { band: 'POOR', min: 0, label: 'Poor' },
];

export function bandLabel(band: QualificationBand): string {
  return BANDS.find((b) => b.band === band)?.label ?? 'Poor';
}

export function classifyBand(score: number): QualificationBand {
  for (const b of BANDS) {
    if (score >= b.min) return b.band;
  }
  return 'POOR';
}

/** All signals UNKNOWN — the honest starting point for a freshly imported prospect. */
export function emptySignals(): QualificationSignals {
  return Object.fromEntries(SIGNAL_KEYS.map((k) => [k, 'UNKNOWN'])) as QualificationSignals;
}

/**
 * Merge partial/untrusted signal input onto a fully-populated default, so an
 * absent or malformed key becomes UNKNOWN rather than throwing or being
 * silently treated as YES.
 */
export function coerceSignals(input: Partial<Record<string, unknown>> | null | undefined): QualificationSignals {
  const result = emptySignals();
  if (!input) return result;
  for (const key of SIGNAL_KEYS) {
    const raw = input[key];
    if (raw === 'YES' || raw === 'NO' || raw === 'UNKNOWN') {
      result[key] = raw;
    }
  }
  return result;
}

/**
 * Merge configured weights over the defaults, ignoring anything non-numeric,
 * negative, or unrecognised. A corrupt settings row degrades to the defaults
 * rather than producing nonsense scores.
 */
export function resolveWeights(
  configured: Record<string, unknown> | null | undefined,
): Record<SignalKey, number> {
  const weights = { ...DEFAULT_WEIGHTS };
  if (!configured) return weights;
  for (const key of SIGNAL_KEYS) {
    const raw = configured[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      weights[key] = Math.round(raw);
    }
  }
  return weights;
}

/**
 * Score a prospect.
 *
 * Only YES contributes points. NO and UNKNOWN both contribute zero, but they
 * are distinguished in the reasons array: "not a US company" is a finding,
 * "we don't know where they are" is a task.
 */
export function scoreProspect(
  signals: QualificationSignals,
  configuredWeights?: Record<string, unknown> | null,
  weightsVersion = 'v1',
): QualificationResult {
  const weights = resolveWeights(configuredWeights);
  const reasons: QualificationReason[] = [];
  const unknownSignals: SignalKey[] = [];
  let score = 0;

  for (const key of SIGNAL_KEYS) {
    const value = signals[key];
    const weight = weights[key];
    if (value === 'YES') {
      score += weight;
      reasons.push({ code: key, label: SIGNAL_LABELS[key], points: weight, value });
    } else {
      if (value === 'UNKNOWN') unknownSignals.push(key);
      reasons.push({ code: key, label: SIGNAL_LABELS[key], points: 0, value });
    }
  }

  const maxPossibleScore = SIGNAL_KEYS.reduce((sum, k) => sum + weights[k], 0);
  // Clamp so custom weights summing above 100 cannot produce an out-of-band score.
  const clamped = Math.max(0, Math.min(100, score));

  return {
    score: clamped,
    band: classifyBand(clamped),
    reasons,
    unknownSignals,
    maxPossibleScore,
    weightsVersion,
  };
}

/** Just the earned reasons, for compact display and for the §13 example shape. */
export function earnedReasons(result: QualificationResult): string[] {
  return result.reasons.filter((r) => r.points > 0).map((r) => r.label);
}
