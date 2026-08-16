/**
 * Deterministic mapping from a free-text job title to a role category, and the
 * priority ordering used to sort the review queue.
 *
 * Pattern matching only — no inference, no external service. When a title does
 * not match anything the result is UNKNOWN, which the UI surfaces as a warning
 * rather than a guess (brief §4: do not automatically target random employees).
 */

export const ROLE_CATEGORIES = [
  'FOUNDER',
  'CO_FOUNDER',
  'CTO',
  'VP_ENGINEERING',
  'HEAD_OF_ENGINEERING',
  'ENGINEERING_MANAGER',
  'TECHNICAL_DECISION_MAKER',
  'OTHER',
  'UNKNOWN',
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

/** Lower number = contact sooner. Drives review-queue ordering. */
export const ROLE_PRIORITY: Record<RoleCategory, number> = {
  FOUNDER: 1,
  CO_FOUNDER: 2,
  CTO: 3,
  VP_ENGINEERING: 4,
  HEAD_OF_ENGINEERING: 5,
  ENGINEERING_MANAGER: 6,
  TECHNICAL_DECISION_MAKER: 7,
  OTHER: 98,
  UNKNOWN: 99,
};

/** Categories that count as "decision maker identified" for qualification. */
const DECISION_MAKER_CATEGORIES = new Set<RoleCategory>([
  'FOUNDER',
  'CO_FOUNDER',
  'CTO',
  'VP_ENGINEERING',
  'HEAD_OF_ENGINEERING',
  'TECHNICAL_DECISION_MAKER',
]);

/**
 * Ordered most specific first. "co-founder" must be tested before "founder",
 * and "vp of engineering" before the generic engineering-manager patterns.
 */
const PATTERNS: { category: RoleCategory; test: RegExp }[] = [
  { category: 'CO_FOUNDER', test: /\b(co[\s-]?founder|cofounder)\b/ },
  { category: 'CTO', test: /\b(cto|chief technology officer|chief technical officer)\b/ },
  { category: 'FOUNDER', test: /\bfounder\b/ },
  { category: 'VP_ENGINEERING', test: /\b(vp|vice president)\b.*\b(eng|engineering|technology|product development)\b/ },
  { category: 'VP_ENGINEERING', test: /\b(svp|evp)\b.*\b(eng|engineering)\b/ },
  { category: 'HEAD_OF_ENGINEERING', test: /\bhead of (eng|engineering|technology|platform|product engineering)\b/ },
  { category: 'HEAD_OF_ENGINEERING', test: /\b(director|chief architect)\b.*\b(eng|engineering|technology|platform)\b/ },
  { category: 'ENGINEERING_MANAGER', test: /\b(engineering manager|eng manager|em|team lead|tech lead|lead engineer)\b/ },
  { category: 'TECHNICAL_DECISION_MAKER', test: /\b(ceo|chief executive officer)\b/ },
  { category: 'TECHNICAL_DECISION_MAKER', test: /\b(cpo|chief product officer|head of product|vp product|product manager|principal engineer|staff engineer|architect)\b/ },
];

/** Classify a job title. Returns UNKNOWN for empty input, OTHER for unrecognised titles. */
export function categorizeRole(role: string | null | undefined): RoleCategory {
  if (!role) return 'UNKNOWN';
  const value = role.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return 'UNKNOWN';

  for (const { category, test } of PATTERNS) {
    if (test.test(value)) return category;
  }
  return 'OTHER';
}

export function isDecisionMaker(category: RoleCategory): boolean {
  return DECISION_MAKER_CATEGORIES.has(category);
}

export function rolePriority(category: RoleCategory): number {
  return ROLE_PRIORITY[category];
}

/** Human-readable label for the UI. */
export function roleCategoryLabel(category: RoleCategory): string {
  switch (category) {
    case 'FOUNDER':
      return 'Founder';
    case 'CO_FOUNDER':
      return 'Co-founder';
    case 'CTO':
      return 'CTO';
    case 'VP_ENGINEERING':
      return 'VP Engineering';
    case 'HEAD_OF_ENGINEERING':
      return 'Head of Engineering';
    case 'ENGINEERING_MANAGER':
      return 'Engineering Manager';
    case 'TECHNICAL_DECISION_MAKER':
      return 'Technical decision maker';
    case 'OTHER':
      return 'Other';
    case 'UNKNOWN':
      return 'Unknown';
  }
}
