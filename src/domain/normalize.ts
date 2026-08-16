/**
 * Deterministic normalisation. Pure, no I/O.
 *
 * These functions define identity for deduplication and for suppression
 * matching. Two things that normalise to the same string ARE the same thing as
 * far as the system is concerned, so the rules here decide whether the same
 * person can be emailed twice. They are intentionally conservative: when in
 * doubt, collapse, because a false merge costs one missed prospect while a
 * false split costs a duplicate cold email to a real person.
 */

/** Domains where the local part carries meaning that dots and tags do not. */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Sub-addressing separators to strip from the local part. */
const PLUS_SEPARATOR = '+';

const WWW_PREFIX = /^www\./;

/**
 * Legal-entity suffixes stripped when comparing company names. Order matters:
 * longer forms first so "Inc." is not left behind after "Incorporated".
 */
const COMPANY_SUFFIXES = [
  'incorporated',
  'corporation',
  'limited liability company',
  'limited',
  'company',
  'holdings',
  'group',
  'labs',
  'inc',
  'llc',
  'llp',
  'ltd',
  'plc',
  'corp',
  'co',
  'gmbh',
  'bv',
  'nv',
  'ab',
  'sa',
  'srl',
  'pty',
];

/**
 * Normalise an email address for identity comparison.
 *
 * - trims and lowercases (mail domains are case-insensitive; virtually every
 *   real provider treats the local part that way too)
 * - strips sub-addressing (`user+tag@` → `user@`)
 * - strips dots in the local part for providers that ignore them
 *
 * Returns null when the input is not a plausible address, so callers must
 * handle "no identity" rather than silently comparing empty strings.
 */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Reject anything with whitespace or control characters: those cannot be a
  // valid address and are a header-injection vector if they ever reach a provider.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;

  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;

  let local = trimmed.slice(0, at);
  const domain = normalizeDomain(trimmed.slice(at + 1));
  if (!domain || !local) return null;

  const plus = local.indexOf(PLUS_SEPARATOR);
  if (plus > 0) local = local.slice(0, plus);
  if (plus === 0) return null; // an address that is only a tag is not valid

  if (DOT_INSENSITIVE_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
  }

  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * Normalise a hostname or URL to a bare registrable-ish domain.
 * Accepts "https://WWW.Example.com/careers", "example.com", "Example.COM.".
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;

  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else if (value.includes('/')) {
    value = value.slice(0, value.indexOf('/'));
  }

  // Strip credentials, port, and a trailing root dot.
  const atIndex = value.lastIndexOf('@');
  if (atIndex >= 0) value = value.slice(atIndex + 1);
  const colon = value.indexOf(':');
  if (colon >= 0) value = value.slice(0, colon);
  value = value.replace(/\.+$/, '');
  value = value.replace(WWW_PREFIX, '');

  if (!value) return null;
  // Must look like a hostname with at least one dot and no invalid characters.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    return null;
  }
  return value;
}

/** The domain portion of a normalised email, used for per-domain rate limits. */
export function emailDomain(input: string | null | undefined): string | null {
  const normalized = normalizeEmail(input);
  if (!normalized) return null;
  return normalized.slice(normalized.lastIndexOf('@') + 1);
}

/**
 * Normalise a company name for duplicate detection: lowercase, strip
 * punctuation and legal suffixes, collapse whitespace.
 *
 * "Acme, Inc." / "ACME Incorporated" / "acme" all collapse to "acme".
 */
export function normalizeCompanyName(input: string | null | undefined): string | null {
  if (!input) return null;

  let value = input
    .normalize('NFKD')
    .toLowerCase()
    // Keep alphanumerics and spaces; ampersand becomes "and" first.
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value) return null;

  // Strip trailing legal suffixes, repeatedly ("Acme Corp Ltd" → "acme").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (value === suffix) break;
      if (value.endsWith(` ${suffix}`)) {
        value = value.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }

  return value || null;
}

/** Split a full name into first/last without inventing parts that are not there. */
export function splitName(fullName: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
  fullName: string;
} {
  const cleaned = (fullName ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { firstName: null, lastName: null, fullName: '' };

  const parts = cleaned.split(' ');
  if (parts.length === 1) {
    return { firstName: parts[0] ?? null, lastName: null, fullName: cleaned };
  }
  return {
    firstName: parts[0] ?? null,
    lastName: parts.slice(1).join(' '),
    fullName: cleaned,
  };
}

/** RFC-pragmatic email shape check. Normalisation is the identity; this is the gate. */
export function isValidEmailShape(input: string | null | undefined): boolean {
  if (!input) return false;
  const value = input.trim();
  if (value.length > 254) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  return /^[^@]+@[^@]+\.[^@]+$/.test(value) && normalizeEmail(value) !== null;
}

/**
 * Validate a URL for storage and rendering. Only http/https survive: this is
 * what stops `javascript:` and `data:` URLs from imported CSVs becoming
 * clickable links in the UI.
 */
export function safeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Bare hostnames are common in CSVs; upgrade rather than reject.
    const domain = normalizeDomain(value);
    return domain ? `https://${domain}` : null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}
