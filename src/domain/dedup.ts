/**
 * Deduplication. Pure, no I/O — callers supply candidate records fetched by
 * normalised key, and this decides what the match means.
 *
 * The ladder, most authoritative first (brief §12):
 *   1. normalised email          → same person, certain
 *   2. company domain + contact  → same person at a known company
 *   3. normalised company name   → same company, possibly a new contact
 *   4. domain                    → same company, possibly a new contact
 */
import { normalizeCompanyName, normalizeDomain, normalizeEmail, splitName } from './normalize.js';

export type DuplicateKind = 'EMAIL' | 'DOMAIN_AND_CONTACT' | 'COMPANY_NAME' | 'DOMAIN' | 'NONE';

export interface DedupKeys {
  normalizedEmail: string | null;
  normalizedDomain: string | null;
  normalizedCompanyName: string | null;
  /** Lowercased full name, used only in combination with a domain. */
  normalizedContactName: string | null;
}

export interface ExistingContactRecord {
  contactId: string;
  companyId: string;
  normalizedEmail: string;
  normalizedContactName: string | null;
  companyNormalizedDomain: string | null;
}

export interface ExistingCompanyRecord {
  companyId: string;
  normalizedName: string;
  normalizedDomain: string | null;
}

export interface DedupInput {
  companyName?: string | null;
  companyDomainOrWebsite?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
}

export interface DedupDecision {
  kind: DuplicateKind;
  /** True when this input must not create a new contact. */
  isDuplicateContact: boolean;
  /** Set when the company already exists and should be reused rather than recreated. */
  existingCompanyId: string | null;
  existingContactId: string | null;
  explanation: string;
}

export function buildDedupKeys(input: DedupInput): DedupKeys {
  const normalizedEmail = normalizeEmail(input.contactEmail);
  // Prefer the explicit domain/website; fall back to the email's domain, which
  // is usually the company domain for a work address.
  const normalizedDomain =
    normalizeDomain(input.companyDomainOrWebsite) ??
    (normalizedEmail ? normalizeDomain(normalizedEmail.slice(normalizedEmail.indexOf('@') + 1)) : null);
  const normalizedCompanyName = normalizeCompanyName(input.companyName);
  const { fullName } = splitName(input.contactName);
  const normalizedContactName = fullName ? fullName.toLowerCase() : null;

  return { normalizedEmail, normalizedDomain, normalizedCompanyName, normalizedContactName };
}

/**
 * Decide whether `input` duplicates something already stored.
 *
 * `contacts` and `companies` are the candidate rows the caller looked up using
 * the keys from `buildDedupKeys` — this function does not query.
 */
export function findDuplicate(
  input: DedupInput,
  candidates: { contacts: ExistingContactRecord[]; companies: ExistingCompanyRecord[] },
): DedupDecision {
  const keys = buildDedupKeys(input);

  // 1. Same normalised email is the same person. Nothing overrides this.
  if (keys.normalizedEmail) {
    const match = candidates.contacts.find((c) => c.normalizedEmail === keys.normalizedEmail);
    if (match) {
      return {
        kind: 'EMAIL',
        isDuplicateContact: true,
        existingCompanyId: match.companyId,
        existingContactId: match.contactId,
        explanation: `A contact with the email ${keys.normalizedEmail} already exists.`,
      };
    }
  }

  // 2. Same person name at the same company domain, under a different address.
  //    Treated as a duplicate because emailing both addresses would reach one human.
  if (keys.normalizedDomain && keys.normalizedContactName) {
    const match = candidates.contacts.find(
      (c) =>
        c.companyNormalizedDomain === keys.normalizedDomain &&
        c.normalizedContactName === keys.normalizedContactName,
    );
    if (match) {
      return {
        kind: 'DOMAIN_AND_CONTACT',
        isDuplicateContact: true,
        existingCompanyId: match.companyId,
        existingContactId: match.contactId,
        explanation: `${input.contactName} already exists at ${keys.normalizedDomain} under a different email address.`,
      };
    }
  }

  // 3 & 4. The company is known but this contact is not: reuse the company,
  //        create the contact. Not a duplicate contact.
  if (keys.normalizedDomain) {
    const match = candidates.companies.find((c) => c.normalizedDomain === keys.normalizedDomain);
    if (match) {
      return {
        kind: 'DOMAIN',
        isDuplicateContact: false,
        existingCompanyId: match.companyId,
        existingContactId: null,
        explanation: `Company ${keys.normalizedDomain} already exists; adding a new contact to it.`,
      };
    }
  }

  if (keys.normalizedCompanyName) {
    const match = candidates.companies.find((c) => c.normalizedName === keys.normalizedCompanyName);
    if (match) {
      return {
        kind: 'COMPANY_NAME',
        isDuplicateContact: false,
        existingCompanyId: match.companyId,
        existingContactId: null,
        explanation: `A company normalising to "${keys.normalizedCompanyName}" already exists; adding a new contact to it.`,
      };
    }
  }

  return {
    kind: 'NONE',
    isDuplicateContact: false,
    existingCompanyId: null,
    existingContactId: null,
    explanation: 'No existing company or contact matched.',
  };
}

/**
 * Detect duplicates *within* one import batch, before any of it is written.
 * Two rows in the same CSV addressing the same person is the most common way a
 * naive importer produces a double send.
 */
export function findIntraBatchDuplicates<T extends DedupInput>(
  rows: T[],
): { index: number; duplicateOfIndex: number; reason: string }[] {
  const seenEmail = new Map<string, number>();
  const seenDomainName = new Map<string, number>();
  const conflicts: { index: number; duplicateOfIndex: number; reason: string }[] = [];

  rows.forEach((row, index) => {
    const keys = buildDedupKeys(row);

    if (keys.normalizedEmail) {
      const prior = seenEmail.get(keys.normalizedEmail);
      if (prior !== undefined) {
        conflicts.push({
          index,
          duplicateOfIndex: prior,
          reason: `Duplicate email ${keys.normalizedEmail} (also on row ${prior + 1}).`,
        });
        return;
      }
      seenEmail.set(keys.normalizedEmail, index);
    }

    if (keys.normalizedDomain && keys.normalizedContactName) {
      const composite = `${keys.normalizedDomain}|${keys.normalizedContactName}`;
      const prior = seenDomainName.get(composite);
      if (prior !== undefined) {
        conflicts.push({
          index,
          duplicateOfIndex: prior,
          reason: `Same person at ${keys.normalizedDomain} (also on row ${prior + 1}).`,
        });
        return;
      }
      seenDomainName.set(composite, index);
    }
  });

  return conflicts;
}
