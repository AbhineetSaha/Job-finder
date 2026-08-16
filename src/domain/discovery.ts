/**
 * Discovery domain logic. Pure, no I/O, no AI.
 *
 * Source adapters fetch raw items; everything about what those items *mean* —
 * whether the company is in scope, how well it matches the operator's skills,
 * whether it shows funding or hiring signals — is decided here, so it can be
 * tested against fixtures without a network.
 *
 * Two rules in this file are load-bearing:
 *
 *   1. Email addresses are only ever EXTRACTED from text the company or person
 *      published. Nothing here permutes `first.last@domain`. Guessed addresses
 *      bounce, and bounces damage the sending domain's reputation — quite apart
 *      from emailing someone who never published a way to reach them.
 *
 *   2. Geography determines a legal posture, not a preference. See
 *      `classifyContactability`.
 */
import { normalizeCompanyName, normalizeDomain, normalizeEmail, safeUrl } from './normalize.js';

/* -------------------------------------------------------------------------- */
/* Geography                                                                  */
/* -------------------------------------------------------------------------- */

export type Contactability = 'OPT_OUT_REGIME' | 'CONSENT_REQUIRED' | 'EXCLUDED' | 'UNKNOWN';

/**
 * Countries whose commercial email regimes are opt-out, i.e. cold outreach is
 * lawful subject to the usual conditions (identification, postal address,
 * working unsubscribe). This is the footing the rest of the system is built on.
 */
const OPT_OUT_COUNTRIES = new Set(['US']);

/**
 * Consent-based regimes. Cold email to these recipients generally requires a
 * lawful basis (GDPR/PECR) or prior consent (CASL), and the analysis is
 * materially different from the US. Candidates are still discovered — knowing
 * a company exists is not the same as emailing it — but promotion requires an
 * explicit acknowledgement.
 */
const CONSENT_REQUIRED_COUNTRIES = new Set([
  // EEA
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
  'SE', 'IS', 'LI', 'NO',
  // Other consent-based or strict regimes
  'GB', 'CH', 'CA', 'AU', 'NZ',
]);

export interface GeographyPolicy {
  /** ISO-3166 alpha-2 codes to drop entirely. */
  excludedCountries: string[];
  /** When non-empty, only these countries are kept. */
  targetCountries: string[];
  /** Keep candidates whose country could not be determined. */
  allowUnknownCountry: boolean;
}

/**
 * The default the operator asked for: everywhere except India, with the US
 * treated as the primary target because that is the regime the outreach
 * machinery is built for.
 */
export const DEFAULT_GEOGRAPHY_POLICY: GeographyPolicy = {
  excludedCountries: ['IN'],
  targetCountries: [],
  allowUnknownCountry: true,
};

export function classifyContactability(country: string | null | undefined): Contactability {
  if (!country) return 'UNKNOWN';
  const code = country.trim().toUpperCase();
  if (code.length !== 2) return 'UNKNOWN';
  if (OPT_OUT_COUNTRIES.has(code)) return 'OPT_OUT_REGIME';
  if (CONSENT_REQUIRED_COUNTRIES.has(code)) return 'CONSENT_REQUIRED';
  return 'UNKNOWN';
}

export interface GeographyDecision {
  keep: boolean;
  country: string | null;
  contactability: Contactability;
  reason: string;
}

export function applyGeographyPolicy(
  country: string | null | undefined,
  policy: GeographyPolicy = DEFAULT_GEOGRAPHY_POLICY,
): GeographyDecision {
  const code = country ? country.trim().toUpperCase() : null;
  const normalized = code && code.length === 2 ? code : null;

  if (!normalized) {
    return {
      keep: policy.allowUnknownCountry,
      country: null,
      contactability: 'UNKNOWN',
      reason: policy.allowUnknownCountry
        ? 'Country unknown; kept for manual review.'
        : 'Country unknown and unknown countries are excluded.',
    };
  }

  if (policy.excludedCountries.map((c) => c.toUpperCase()).includes(normalized)) {
    return {
      keep: false,
      country: normalized,
      contactability: 'EXCLUDED',
      reason: `${normalized} is on the exclusion list.`,
    };
  }

  if (
    policy.targetCountries.length > 0 &&
    !policy.targetCountries.map((c) => c.toUpperCase()).includes(normalized)
  ) {
    return {
      keep: false,
      country: normalized,
      contactability: classifyContactability(normalized),
      reason: `${normalized} is not in the target country list.`,
    };
  }

  return {
    keep: true,
    country: normalized,
    contactability: classifyContactability(normalized),
    reason: `${normalized} is in scope.`,
  };
}

/**
 * Map a free-text location to a country code.
 *
 * Deliberately conservative: it recognises explicit country names, US state
 * names and codes, and a list of unambiguous major cities. Anything it is not
 * sure about returns null, which surfaces as "country unknown" for the
 * operator to resolve, rather than a confident wrong answer.
 */
const COUNTRY_PATTERNS: [RegExp, string][] = [
  [/\b(united states|u\.?s\.?a\.?|usa)\b/i, 'US'],
  [/\b(united kingdom|u\.?k\.?|england|scotland|wales|london)\b/i, 'GB'],
  [/\b(canada|toronto|vancouver|montreal|ottawa)\b/i, 'CA'],
  [/\b(germany|deutschland|berlin|munich|hamburg)\b/i, 'DE'],
  [/\b(france|paris|lyon)\b/i, 'FR'],
  [/\b(netherlands|holland|amsterdam)\b/i, 'NL'],
  [/\b(ireland|dublin)\b/i, 'IE'],
  [/\b(spain|madrid|barcelona)\b/i, 'ES'],
  [/\b(sweden|stockholm)\b/i, 'SE'],
  [/\b(switzerland|zurich|geneva)\b/i, 'CH'],
  [/\b(australia|sydney|melbourne)\b/i, 'AU'],
  [/\b(singapore)\b/i, 'SG'],
  [/\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai|gurgaon|noida)\b/i, 'IN'],
  [/\b(israel|tel aviv)\b/i, 'IL'],
  [/\b(japan|tokyo)\b/i, 'JP'],
  [/\b(brazil|brasil|sao paulo)\b/i, 'BR'],
];

export function isUsStateCode(value: string | null | undefined): boolean {
  if (!value) return false;
  return US_STATE_CODES.has(value.trim().toUpperCase());
}

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const US_CITIES = [
  'san francisco', 'new york', 'nyc', 'seattle', 'austin', 'boston', 'chicago',
  'los angeles', 'denver', 'atlanta', 'portland', 'miami', 'san diego',
  'palo alto', 'mountain view', 'menlo park', 'sunnyvale', 'brooklyn',
  'bay area', 'silicon valley', 'san jose', 'philadelphia', 'pittsburgh',
  'nashville', 'salt lake city', 'minneapolis', 'washington dc',
];

export function inferCountry(location: string | null | undefined): string | null {
  if (!location) return null;
  const text = location.trim();
  if (!text) return null;

  // Bare "US"/"U.S." is extremely common in job-post location fields
  // ("Remote (US)"). Matched case-sensitively so the English pronoun "us"
  // in prose does not resolve to a country.
  if (/(^|[^A-Za-z])(US|U\.S\.?)([^A-Za-z]|$)/.test(text)) return 'US';

  // "Bangalore, India" must resolve to IN even though it also mentions a city
  // pattern, so explicit country names are tested first.
  for (const [pattern, code] of COUNTRY_PATTERNS) {
    if (pattern.test(text)) return code;
  }

  const lower = text.toLowerCase();
  if (US_CITIES.some((city) => lower.includes(city))) return 'US';

  // "Austin, TX" — a two-letter token that is a US state code.
  for (const token of text.split(/[,\s/|]+/)) {
    const upper = token.trim().toUpperCase().replace(/\.$/, '');
    if (upper.length === 2 && US_STATE_CODES.has(upper)) return 'US';
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Profile matching                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Technology aliases, so "postgres", "postgresql" and "psql" all count as the
 * same skill. Keys are the canonical form used in scoring.
 */
const TECH_ALIASES: Record<string, string[]> = {
  java: ['java', 'jvm', 'j2ee'],
  'spring boot': ['spring boot', 'springboot', 'spring-boot', 'spring'],
  typescript: ['typescript', 'ts'],
  javascript: ['javascript', 'js', 'ecmascript'],
  'node.js': ['node.js', 'nodejs', 'node'],
  react: ['react', 'react.js', 'reactjs'],
  'next.js': ['next.js', 'nextjs', 'next'],
  postgresql: ['postgresql', 'postgres', 'psql', 'pg'],
  sql: ['sql'],
  'drizzle orm': ['drizzle', 'drizzle orm'],
  supabase: ['supabase'],
  git: ['git'],
  github: ['github'],
  docker: ['docker'],
  kubernetes: ['kubernetes', 'k8s'],
  aws: ['aws', 'amazon web services'],
  graphql: ['graphql'],
  python: ['python'],
  go: ['go', 'golang', 'go lang'],
  rust: ['rust'],
  ruby: ['ruby', 'rails', 'ruby on rails'],
  php: ['php', 'laravel'],
  dotnet: ['.net', 'dotnet', 'c#', 'csharp'],
};

/**
 * Aliases too ambiguous to search for inside free text. They are still valid
 * for exact-token canonicalisation — a GitHub `language: "Go"` field means the
 * language — but "we go fast" in a job post does not.
 */
const AMBIGUOUS_IN_TEXT = new Set(['go', 'js', 'ts', 'pg', 'r', 'c#']);

/** Canonicalise a technology token; returns null if it is not recognised. */
export function canonicalizeTech(token: string): string | null {
  const value = token.trim().toLowerCase();
  if (!value) return null;
  for (const [canonical, aliases] of Object.entries(TECH_ALIASES)) {
    if (aliases.includes(value)) return canonical;
  }
  return null;
}

/**
 * Extract recognised technologies from free text.
 *
 * Word-boundary matched so "go" does not match "going" and "react" does not
 * match "reactive".
 */
export function extractTechnologies(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const haystack = text.toLowerCase();

  for (const [canonical, aliases] of Object.entries(TECH_ALIASES)) {
    for (const alias of aliases) {
      if (AMBIGUOUS_IN_TEXT.has(alias)) continue;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // \b does not work before "." or "#", so allow a non-word left boundary.
      const pattern = new RegExp(`(^|[^a-z0-9+#.])${escaped}($|[^a-z0-9+#])`, 'i');
      if (pattern.test(haystack)) {
        found.add(canonical);
        break;
      }
    }
  }

  return [...found].sort();
}

export interface MatchProfile {
  /** The operator's skills, from user_profiles.skills. */
  skills: string[];
  /** Industries of interest, matched case-insensitively against the description. */
  industries: string[];
}

export interface MatchResult {
  score: number;
  reasons: string[];
  matchedTechnologies: string[];
}

/**
 * Score how well a candidate matches the operator's profile. Deterministic and
 * explainable: every point is attributable to a stated reason.
 *
 *   technology overlap   up to 50   (10 per matched technology)
 *   funding signal              20
 *   hiring signal               20
 *   industry match              10
 */
export function scoreProfileMatch(
  candidate: {
    technologyStack: string[];
    fundingSignals: string[];
    hiringSignals: string[];
    description?: string | null;
  },
  profile: MatchProfile,
): MatchResult {
  const reasons: string[] = [];

  const profileTech = new Set(
    profile.skills.map((s) => canonicalizeTech(s)).filter((s): s is string => s !== null),
  );
  const candidateTech = new Set(
    candidate.technologyStack
      .map((t) => canonicalizeTech(t))
      .filter((t): t is string => t !== null),
  );

  const matchedTechnologies = [...candidateTech].filter((t) => profileTech.has(t)).sort();

  let score = 0;

  if (matchedTechnologies.length > 0) {
    const points = Math.min(50, matchedTechnologies.length * 10);
    score += points;
    reasons.push(`Technology match: ${matchedTechnologies.join(', ')} (+${points})`);
  }

  if (candidate.fundingSignals.length > 0) {
    score += 20;
    reasons.push(`Funding signal: ${candidate.fundingSignals.join('; ')} (+20)`);
  }

  if (candidate.hiringSignals.length > 0) {
    score += 20;
    reasons.push(`Hiring signal: ${candidate.hiringSignals.join('; ')} (+20)`);
  }

  const description = (candidate.description ?? '').toLowerCase();
  const industryHit = profile.industries.find(
    (industry) => industry.trim() !== '' && description.includes(industry.toLowerCase()),
  );
  if (industryHit) {
    score += 10;
    reasons.push(`Industry match: ${industryHit} (+10)`);
  }

  if (reasons.length === 0) {
    reasons.push('No recognised technology, funding, or hiring signal.');
  }

  return { score: Math.min(100, score), reasons, matchedTechnologies };
}

/* -------------------------------------------------------------------------- */
/* Signal detection                                                           */
/* -------------------------------------------------------------------------- */

const FUNDING_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/\b(pre-?seed)\b/i, () => 'Pre-seed'],
  [/\bseed(?:\s+(?:round|funded|stage))?\b/i, () => 'Seed'],
  [/\bseries\s+([a-f])\b/i, (m) => `Series ${(m[1] ?? '').toUpperCase()}`],
  [/\braised\s+\$?\s?([\d.]+)\s*(m|mm|million|b|bn|billion|k)\b/i, (m) => `Raised ${m[1]}${(m[2] ?? '').toUpperCase()}`],
  [/\b\$\s?([\d.]+)\s*(m|mm|million|b|bn|billion)\b/i, (m) => `$${m[1]}${(m[2] ?? '').toUpperCase()} mentioned`],
  [/\b(y\s?combinator|yc\s?[wsf]\d{2})\b/i, () => 'Y Combinator'],
  [/\b(techstars)\b/i, () => 'Techstars'],
  [/\b(a16z|andreessen|sequoia|accel|benchmark|greylock|index ventures|lightspeed)\b/i, (m) => `Backed by ${m[1]}`],
  [/\b(venture[- ]backed|vc[- ]backed|well[- ]funded|newly funded)\b/i, () => 'Venture-backed'],
  [/\b(form\s?d|regulation\s?d)\b/i, () => 'SEC Form D filing'],
];

/** Extract funding signals from free text. Returns deduplicated labels. */
export function detectFundingSignals(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();

  for (const [pattern, label] of FUNDING_PATTERNS) {
    const match = text.match(pattern);
    if (match) found.add(label(match));
  }

  return [...found];
}

const HIRING_PATTERNS: [RegExp, string][] = [
  [/\b(hiring|we're hiring|now hiring)\b/i, 'Explicitly hiring'],
  [/\b(backend|back-end)\s+(engineer|developer)\b/i, 'Hiring backend engineers'],
  [/\b(full[- ]?stack)\s+(engineer|developer)\b/i, 'Hiring full-stack engineers'],
  [/\b(senior|staff|principal)\s+(?:[a-z-]+\s+){0,2}(engineer|developer)\b/i, 'Hiring senior engineers'],
  [/\b(contract|contractor|freelance|fractional|part[- ]time)\b/i, 'Open to contract work'],
  [/\b(remote)\b/i, 'Remote-friendly'],
  [/\bopen (roles|positions)\b/i, 'Open roles listed'],
];

export function detectHiringSignals(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const [pattern, label] of HIRING_PATTERNS) {
    if (pattern.test(text)) found.add(label);
  }
  return [...found];
}

/**
 * Contract-work signals specifically, since they are the highest-value signal
 * for a freelancer and worth surfacing separately from general hiring.
 */
export function hasContractSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(contract|contractor|freelance|fractional|consultant|agency|part[- ]time)\b/i.test(text);
}

/* -------------------------------------------------------------------------- */
/* Published contact extraction                                               */
/* -------------------------------------------------------------------------- */

/** Addresses that are never a useful outreach target even when published. */
const ROLE_ADDRESS_PREFIXES = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'abuse',
  'mailer-daemon', 'bounce', 'bounces', 'unsubscribe', 'privacy', 'legal',
  'security', 'dmca', 'webmaster', 'root', 'admin', 'test', 'example',
]);

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Extract email addresses that appear verbatim in supplied text.
 *
 * This is the ONLY way an address enters the system from a source. There is no
 * pattern-guessing function anywhere in this codebase, and adding one would be
 * a mistake: a guessed address bounces, and enough bounces will get the
 * operator's sending domain blocked.
 */
export function extractPublishedEmails(text: string | null | undefined): string[] {
  if (!text) return [];

  const found = new Set<string>();
  for (const raw of text.match(EMAIL_IN_TEXT) ?? []) {
    const normalized = normalizeEmail(raw);
    if (!normalized) continue;

    const local = normalized.slice(0, normalized.indexOf('@'));
    if (ROLE_ADDRESS_PREFIXES.has(local)) continue;
    // Reserved documentation domains are never real contacts.
    if (/\.(example|invalid|test|localhost)$/.test(normalized)) continue;
    if (/@(example\.(com|org|net))$/.test(normalized)) continue;

    found.add(normalized);
  }

  return [...found];
}

/* -------------------------------------------------------------------------- */
/* Candidate normalisation                                                    */
/* -------------------------------------------------------------------------- */

/** What a source adapter produces, before policy and scoring are applied. */
export interface RawCandidate {
  companyName: string;
  website?: string | null;
  domain?: string | null;
  description?: string | null;
  locationText?: string | null;
  country?: string | null;
  technologyStack?: string[];
  fundingSignals?: string[];
  hiringSignals?: string[];
  publishedEmail?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  sourceUrl?: string | null;
  raw?: Record<string, unknown>;
  /** Free text the adapter wants mined for signals (job post body, README, …). */
  signalText?: string | null;
}

export interface NormalizedCandidate {
  companyName: string;
  normalizedName: string;
  domain: string | null;
  normalizedDomain: string | null;
  website: string | null;
  description: string | null;
  locationText: string | null;
  country: string | null;
  contactability: Contactability;
  technologyStack: string[];
  fundingSignals: string[];
  hiringSignals: string[];
  publishedEmail: string | null;
  contactName: string | null;
  contactRole: string | null;
  matchScore: number;
  matchReasons: string[];
  sourceUrl: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizeOutcome {
  keep: boolean;
  reason: string;
  candidate: NormalizedCandidate | null;
}

export interface NormalizeOptions {
  policy?: GeographyPolicy;
  profile: MatchProfile;
  /** Candidates scoring below this are dropped rather than staged. */
  minMatchScore?: number;
}

/**
 * Turn a raw source item into a scored, policy-checked candidate.
 *
 * Returns `keep: false` with a reason rather than throwing, so a run can
 * report exactly why each item was dropped.
 */
export function normalizeCandidate(
  raw: RawCandidate,
  options: NormalizeOptions,
): NormalizeOutcome {
  const companyName = raw.companyName.trim();
  const normalizedName = normalizeCompanyName(companyName);

  if (!companyName || !normalizedName) {
    return { keep: false, reason: 'No usable company name.', candidate: null };
  }

  const website = safeUrl(raw.website ?? raw.domain ?? null);
  const normalizedDomain = normalizeDomain(raw.domain ?? raw.website ?? null);

  const country = raw.country ?? inferCountry(raw.locationText);
  const geography = applyGeographyPolicy(country, options.policy ?? DEFAULT_GEOGRAPHY_POLICY);

  if (!geography.keep) {
    return { keep: false, reason: geography.reason, candidate: null };
  }

  // Signals come from whatever the adapter provides plus anything mined from
  // the free text it supplies.
  const signalText = [raw.signalText, raw.description].filter(Boolean).join('\n');

  const technologyStack = [
    ...new Set([...(raw.technologyStack ?? []), ...extractTechnologies(signalText)]),
  ]
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 40);

  const fundingSignals = [
    ...new Set([...(raw.fundingSignals ?? []), ...detectFundingSignals(signalText)]),
  ].slice(0, 20);

  const hiringSignals = [
    ...new Set([...(raw.hiringSignals ?? []), ...detectHiringSignals(signalText)]),
  ].slice(0, 20);

  const match = scoreProfileMatch(
    { technologyStack, fundingSignals, hiringSignals, description: raw.description ?? null },
    options.profile,
  );

  const threshold = options.minMatchScore ?? 0;
  if (match.score < threshold) {
    return {
      keep: false,
      reason: `Match score ${match.score} is below the threshold of ${threshold}.`,
      candidate: null,
    };
  }

  // Only an address the source actually published.
  const publishedEmail =
    normalizeEmail(raw.publishedEmail) ?? extractPublishedEmails(signalText)[0] ?? null;

  return {
    keep: true,
    reason: geography.reason,
    candidate: {
      companyName: companyName.slice(0, 300),
      normalizedName,
      domain: normalizedDomain,
      normalizedDomain,
      website,
      description: raw.description?.trim().slice(0, 2000) ?? null,
      locationText: raw.locationText?.trim().slice(0, 200) ?? null,
      country: geography.country,
      contactability: geography.contactability,
      technologyStack,
      fundingSignals,
      hiringSignals,
      publishedEmail,
      contactName: raw.contactName?.trim().slice(0, 200) ?? null,
      contactRole: raw.contactRole?.trim().slice(0, 200) ?? null,
      matchScore: match.score,
      matchReasons: match.reasons,
      sourceUrl: safeUrl(raw.sourceUrl ?? null),
      raw: raw.raw ?? {},
    },
  };
}

/**
 * Whether a candidate may be promoted to a prospect, and why not if not.
 *
 * A consent-required jurisdiction is not a hard block — the operator may have
 * a lawful basis — but it must be an explicit, acknowledged decision rather
 * than something that happens by clicking through.
 */
export function canPromote(
  candidate: Pick<NormalizedCandidate, 'contactability' | 'publishedEmail'>,
  options: { contactEmail?: string | null; acknowledgedConsentRisk?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  const email = normalizeEmail(options.contactEmail ?? candidate.publishedEmail);

  if (!email) {
    return {
      ok: false,
      reason:
        'No published contact address. Find one the company has made public, or enter it manually — this system never guesses addresses.',
    };
  }

  if (candidate.contactability === 'EXCLUDED') {
    return { ok: false, reason: 'This country is on the exclusion list.' };
  }

  if (candidate.contactability === 'CONSENT_REQUIRED' && !options.acknowledgedConsentRisk) {
    return {
      ok: false,
      reason:
        'This company is in a consent-based jurisdiction (GDPR/PECR or CASL). Cold email there generally requires a lawful basis or prior consent. Confirm you have taken advice before promoting.',
    };
  }

  return { ok: true };
}
