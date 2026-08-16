/**
 * Deterministic email template engine. Pure, no I/O, no AI.
 *
 * The single most important property: a missing variable is an ERROR, never a
 * blank and never a substituted guess. An email that renders "I noticed  ." or
 * "I noticed {{specific_observation}}." would be worse than not sending at all,
 * so `render()` refuses and the draft cannot be approved (brief §17, §19).
 */

/** `{{ variable_name }}` — snake_case identifiers only, optional inner whitespace. */
const VARIABLE_PATTERN = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

/** Anything that looks like a placeholder but is not a valid variable reference. */
const MALFORMED_PATTERN = /\{\{(?!\s*[a-z0-9_]+\s*\}\})[^}]*\}\}/g;

export const KNOWN_VARIABLES = [
  'first_name',
  'last_name',
  'full_name',
  'company_name',
  'company_description',
  'specific_observation',
  'engineering_signal',
  'pain_point',
  'why_relevant',
  'specific_offer',
  'relevant_service',
  'relevant_technology',
  'portfolio_url',
  'sender_name',
  'sender_title',
  'sender_email',
  'contact_role',
] as const;

export type KnownVariable = (typeof KNOWN_VARIABLES)[number];

export interface RenderSuccess {
  ok: true;
  text: string;
  /** Exactly what was interpolated, retained on the message for audit. */
  used: Record<string, string>;
}

export interface RenderFailure {
  ok: false;
  missing: string[];
  unknown: string[];
  malformed: string[];
  message: string;
}

export type RenderResult = RenderSuccess | RenderFailure;

/** Every variable a template references, deduplicated, in first-appearance order. */
export function extractVariables(template: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

/** Placeholder-looking fragments that will never interpolate — a template authoring bug. */
export function findMalformedPlaceholders(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(MALFORMED_PATTERN), (m) => m[0]))];
}

/** Variables referenced by a template that are not in the known set. */
export function findUnknownVariables(template: string): string[] {
  const known = new Set<string>(KNOWN_VARIABLES);
  return extractVariables(template).filter((v) => !known.has(v));
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/**
 * Render a template.
 *
 * Fails when: a referenced variable is absent or blank, a referenced variable
 * is not a known variable, or the template contains a malformed placeholder.
 * Never substitutes a default. Never emits an empty string for a missing value.
 */
export function render(
  template: string,
  values: Partial<Record<string, string | null | undefined>>,
): RenderResult {
  const referenced = extractVariables(template);
  const malformed = findMalformedPlaceholders(template);
  const known = new Set<string>(KNOWN_VARIABLES);

  const unknown = referenced.filter((name) => !known.has(name));
  const missing = referenced.filter((name) => known.has(name) && isBlank(values[name]));

  if (missing.length || unknown.length || malformed.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing values for: ${missing.join(', ')}`);
    if (unknown.length) parts.push(`unknown variables: ${unknown.join(', ')}`);
    if (malformed.length) parts.push(`malformed placeholders: ${malformed.join(', ')}`);
    return {
      ok: false,
      missing,
      unknown,
      malformed,
      message: `Template cannot be rendered — ${parts.join('; ')}.`,
    };
  }

  const used: Record<string, string> = {};
  const text = template.replace(VARIABLE_PATTERN, (_full, rawName: string) => {
    const value = (values[rawName] ?? '').trim();
    used[rawName] = value;
    return value;
  });

  return { ok: true, text, used };
}

export interface RenderedEmail {
  subject: string;
  body: string;
  used: Record<string, string>;
}

/**
 * Render subject and body together so a partial render can never be persisted.
 * Also rejects CR/LF in the subject, which is an email header-injection vector.
 */
export function renderEmail(
  subjectTemplate: string,
  bodyTemplate: string,
  values: Partial<Record<string, string | null | undefined>>,
): { ok: true; email: RenderedEmail } | { ok: false; error: RenderFailure } {
  const subject = render(subjectTemplate, values);
  if (!subject.ok) return { ok: false, error: subject };

  const body = render(bodyTemplate, values);
  if (!body.ok) return { ok: false, error: body };

  if (/[\r\n]/.test(subject.text)) {
    return {
      ok: false,
      error: {
        ok: false,
        missing: [],
        unknown: [],
        malformed: [],
        message: 'Subject must not contain line breaks.',
      },
    };
  }

  return {
    ok: true,
    email: {
      subject: subject.text.trim(),
      body: body.text,
      used: { ...subject.used, ...body.used },
    },
  };
}

/**
 * Append the compliance footer: sender identification, physical postal address,
 * and the unsubscribe link. Kept out of the template so an operator cannot
 * delete it by editing a template (brief §45, CAN-SPAM).
 */
export function appendComplianceFooter(
  body: string,
  footer: {
    senderName: string;
    senderEmail: string;
    postalAddress: string;
    unsubscribeUrl: string;
    advertisingDisclosure?: string;
    customFooter?: string;
  },
): string {
  const lines: string[] = [body.trimEnd(), '', '--'];

  if (footer.customFooter?.trim()) lines.push(footer.customFooter.trim());
  if (footer.advertisingDisclosure?.trim()) lines.push(footer.advertisingDisclosure.trim());

  lines.push(`${footer.senderName} · ${footer.senderEmail}`);
  lines.push(footer.postalAddress.trim());
  lines.push('');
  lines.push(`Don't want to hear from me again? Unsubscribe: ${footer.unsubscribeUrl}`);

  return lines.join('\n');
}
