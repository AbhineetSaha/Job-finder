/**
 * Prospect creation, import, and querying.
 *
 * Deduplication runs inside the same transaction as the insert, and the
 * database's partial unique indexes are the final authority — an application
 * check that races is caught by the constraint rather than producing a
 * duplicate person who could be emailed twice.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  companies,
  contacts,
  prospects,
  research,
  type Company,
  type Contact,
  type Prospect,
} from '../db/schema.js';
import {
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  safeUrl,
  splitName,
} from '../domain/normalize.js';
import { findDuplicate, type ExistingCompanyRecord, type ExistingContactRecord } from '../domain/dedup.js';
import { categorizeRole } from '../domain/roles.js';
import { canTransition, type ProspectStatus } from '../domain/status.js';
import type { ParsedImportRow } from '../domain/csv.js';
import { recordActivity, recordAudit } from './audit.js';
import { logger } from '../lib/logger.js';

export interface CreateProspectInput {
  userId: string;
  companyName: string;
  website?: string | null;
  companyLinkedinUrl?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  contactEmail: string;
  contactLinkedinUrl?: string | null;
  contactReason?: string | null;
  sourceUrl?: string | null;
  source?: string;
  country?: string;
  state?: string | null;
  city?: string | null;
  timezone?: string | null;
  industry?: string | null;
  companySize?: string | null;
  fundingStage?: string | null;
  companyDescription?: string | null;
  technologyStack?: string[];
  notes?: string | null;
}

export type CreateProspectResult =
  | { ok: true; prospect: Prospect; company: Company; contact: Contact; reusedCompany: boolean }
  | { ok: false; error: string; duplicateOf?: { prospectId?: string; contactId: string } };

/** Look up the candidate rows deduplication needs, by normalised key. */
async function loadDedupCandidates(
  tx: Database,
  userId: string,
  keys: { normalizedEmail: string | null; normalizedDomain: string | null; normalizedName: string | null },
): Promise<{ contacts: ExistingContactRecord[]; companies: ExistingCompanyRecord[] }> {
  const contactConditions = [];
  if (keys.normalizedEmail) contactConditions.push(eq(contacts.normalizedEmail, keys.normalizedEmail));
  if (keys.normalizedDomain) contactConditions.push(eq(companies.normalizedDomain, keys.normalizedDomain));

  const contactRows = contactConditions.length
    ? await tx
        .select({
          contactId: contacts.id,
          companyId: contacts.companyId,
          normalizedEmail: contacts.normalizedEmail,
          fullName: contacts.fullName,
          companyNormalizedDomain: companies.normalizedDomain,
        })
        .from(contacts)
        .innerJoin(companies, eq(companies.id, contacts.companyId))
        .where(and(eq(contacts.userId, userId), or(...contactConditions)))
        .limit(200)
    : [];

  const companyConditions = [];
  if (keys.normalizedDomain) companyConditions.push(eq(companies.normalizedDomain, keys.normalizedDomain));
  if (keys.normalizedName) companyConditions.push(eq(companies.normalizedName, keys.normalizedName));

  const companyRows = companyConditions.length
    ? await tx
        .select({
          companyId: companies.id,
          normalizedName: companies.normalizedName,
          normalizedDomain: companies.normalizedDomain,
        })
        .from(companies)
        .where(and(eq(companies.userId, userId), or(...companyConditions)))
        .limit(200)
    : [];

  return {
    contacts: contactRows.map((r) => ({
      contactId: r.contactId,
      companyId: r.companyId,
      normalizedEmail: r.normalizedEmail,
      normalizedContactName: r.fullName ? r.fullName.toLowerCase() : null,
      companyNormalizedDomain: r.companyNormalizedDomain,
    })),
    companies: companyRows,
  };
}

/**
 * Create a company (or reuse an existing one), a contact, and a prospect.
 * Runs inside the caller's transaction when given one, so a CSV import is
 * all-or-nothing per row.
 */
export async function createProspect(
  input: CreateProspectInput,
  existingTx?: Database,
): Promise<CreateProspectResult> {
  const run = async (tx: Database): Promise<CreateProspectResult> => {
    const normalizedEmail = normalizeEmail(input.contactEmail);
    if (!normalizedEmail) {
      return { ok: false, error: `"${input.contactEmail}" is not a valid email address.` };
    }

    const normalizedDomain =
      normalizeDomain(input.website) ??
      normalizeDomain(normalizedEmail.slice(normalizedEmail.indexOf('@') + 1));
    const normalizedName = normalizeCompanyName(input.companyName);
    if (!normalizedName) {
      return { ok: false, error: 'Company name is required.' };
    }

    const candidates = await loadDedupCandidates(tx, input.userId, {
      normalizedEmail,
      normalizedDomain,
      normalizedName,
    });

    const decision = findDuplicate(
      {
        companyName: input.companyName,
        companyDomainOrWebsite: input.website ?? normalizedDomain,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
      },
      candidates,
    );

    if (decision.isDuplicateContact && decision.existingContactId) {
      const existingProspect = await tx
        .select({ id: prospects.id })
        .from(prospects)
        .where(eq(prospects.contactId, decision.existingContactId))
        .limit(1);

      return {
        ok: false,
        error: decision.explanation,
        duplicateOf: {
          contactId: decision.existingContactId,
          ...(existingProspect[0] ? { prospectId: existingProspect[0].id } : {}),
        },
      };
    }

    let company: Company;
    let reusedCompany = false;

    if (decision.existingCompanyId) {
      const rows = await tx
        .select()
        .from(companies)
        .where(and(eq(companies.id, decision.existingCompanyId), eq(companies.userId, input.userId)))
        .limit(1);
      const found = rows[0];
      if (!found) return { ok: false, error: 'The matched company could not be loaded.' };
      company = found;
      reusedCompany = true;
    } else {
      const inserted = await tx
        .insert(companies)
        .values({
          userId: input.userId,
          name: input.companyName.trim(),
          normalizedName,
          domain: normalizedDomain,
          normalizedDomain,
          website: safeUrl(input.website),
          linkedinUrl: safeUrl(input.companyLinkedinUrl),
          country: input.country?.trim() || 'US',
          state: input.state ?? null,
          city: input.city ?? null,
          timezone: input.timezone ?? null,
          industry: input.industry ?? null,
          companySize: input.companySize ?? null,
          fundingStage: input.fundingStage ?? null,
          description: input.companyDescription ?? null,
          technologyStack: input.technologyStack ?? [],
          source: input.source ?? 'MANUAL',
          sourceUrl: safeUrl(input.sourceUrl),
        })
        .returning();

      const created = inserted[0];
      if (!created) return { ok: false, error: 'Failed to create the company record.' };
      company = created;
    }

    const { firstName, lastName, fullName } = splitName(input.contactName);

    const contactRows = await tx
      .insert(contacts)
      .values({
        userId: input.userId,
        companyId: company.id,
        firstName,
        lastName,
        fullName: fullName || input.contactEmail,
        role: input.contactRole ?? null,
        roleCategory: categorizeRole(input.contactRole),
        email: input.contactEmail.trim(),
        normalizedEmail,
        linkedinUrl: safeUrl(input.contactLinkedinUrl),
        timezone: input.timezone ?? null,
        contactReason: input.contactReason ?? null,
      })
      .returning();

    const contact = contactRows[0];
    if (!contact) return { ok: false, error: 'Failed to create the contact record.' };

    const prospectRows = await tx
      .insert(prospects)
      .values({
        userId: input.userId,
        companyId: company.id,
        contactId: contact.id,
        status: 'DISCOVERED',
        notes: input.notes ?? null,
      })
      .returning();

    const prospect = prospectRows[0];
    if (!prospect) return { ok: false, error: 'Failed to create the prospect record.' };

    // Create the empty research row up front so the research screen always has
    // somewhere to write and never needs an upsert dance.
    await tx.insert(research).values({ prospectId: prospect.id }).onConflictDoNothing();

    await recordActivity(
      {
        userId: input.userId,
        prospectId: prospect.id,
        type: 'PROSPECT_CREATED',
        title: `Prospect added: ${contact.fullName} at ${company.name}`,
        metadata: { source: input.source ?? 'MANUAL', reusedCompany },
      },
      tx,
    );

    await recordAudit(
      {
        userId: input.userId,
        action: input.source === 'CSV' ? 'PROSPECT_IMPORTED' : 'PROSPECT_CREATED',
        entityType: 'prospect',
        entityId: prospect.id,
        metadata: { companyId: company.id, contactId: contact.id, reusedCompany },
      },
      tx,
    );

    return { ok: true, prospect, company, contact, reusedCompany };
  };

  if (existingTx) return run(existingTx);

  try {
    return await getDb().transaction(run);
  } catch (error) {
    // A unique-violation here means a concurrent insert won the race — which is
    // the constraint doing exactly its job.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('duplicate key') || message.includes('unique constraint')) {
      return { ok: false, error: 'That company or contact already exists.' };
    }
    logger.error('createProspect failed', { event: 'prospect_create_failed', error: message });
    return { ok: false, error: 'Could not create the prospect.' };
  }
}

export interface ImportSummary {
  created: number;
  skipped: number;
  failed: number;
  details: { rowNumber: number; status: 'created' | 'skipped' | 'failed'; message: string }[];
}

/**
 * Import validated rows. Each row is its own transaction so one bad row does
 * not discard the whole file, and duplicates are reported rather than merged.
 */
export async function importProspects(
  userId: string,
  rows: ParsedImportRow[],
): Promise<ImportSummary> {
  const summary: ImportSummary = { created: 0, skipped: 0, failed: 0, details: [] };

  for (const row of rows) {
    const result = await createProspect({
      userId,
      source: 'CSV',
      companyName: row.companyName,
      website: row.website,
      companyLinkedinUrl: row.companyLinkedinUrl,
      contactName: row.contactName,
      contactRole: row.contactRole,
      contactEmail: row.contactEmail,
      contactLinkedinUrl: row.contactLinkedinUrl,
      sourceUrl: row.sourceUrl,
      country: row.country,
      state: row.state,
      city: row.city,
      timezone: row.timezone,
      industry: row.industry,
      companySize: row.companySize,
      fundingStage: row.fundingStage,
      companyDescription: row.companyDescription,
      technologyStack: row.technologyStack,
      notes: row.notes,
    });

    if (result.ok) {
      summary.created += 1;
      summary.details.push({
        rowNumber: row.rowNumber,
        status: 'created',
        message: `Created ${row.contactEmail}`,
      });
    } else if (result.duplicateOf) {
      summary.skipped += 1;
      summary.details.push({ rowNumber: row.rowNumber, status: 'skipped', message: result.error });
    } else {
      summary.failed += 1;
      summary.details.push({ rowNumber: row.rowNumber, status: 'failed', message: result.error });
    }
  }

  logger.info('CSV import complete', {
    event: 'prospects_imported',
    userId,
    ...summary,
    details: undefined,
  });

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Querying                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProspectFilters {
  search?: string;
  status?: ProspectStatus[];
  minScore?: number;
  maxScore?: number;
  industry?: string;
  serviceId?: string;
  campaignId?: string;
  timezone?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  lastContactedBefore?: Date;
  followUpDueBefore?: Date;
  sort?: 'score' | 'created' | 'updated' | 'company';
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type ProspectListItem = {
  prospect: Prospect;
  company: Company;
  contact: Contact;
};

const MAX_PAGE_SIZE = 100;

/**
 * Filtered, paginated prospect list. All filtering happens in SQL — no
 * endpoint ever loads the whole table into memory (brief §49, §50).
 */
export async function listProspects(
  userId: string,
  filters: ProspectFilters = {},
  page = 1,
  pageSize = 25,
): Promise<Page<ProspectListItem>> {
  const db = getDb();
  const limit = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
  const currentPage = Math.max(1, page);
  const offset = (currentPage - 1) * limit;

  const conditions = [eq(prospects.userId, userId)];

  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        ilike(companies.name, term),
        ilike(companies.normalizedDomain, term),
        ilike(contacts.fullName, term),
        ilike(contacts.email, term),
      )!,
    );
  }
  if (filters.status?.length) conditions.push(inArray(prospects.status, filters.status));
  if (typeof filters.minScore === 'number') {
    conditions.push(gte(prospects.qualificationScore, filters.minScore));
  }
  if (typeof filters.maxScore === 'number') {
    conditions.push(lte(prospects.qualificationScore, filters.maxScore));
  }
  if (filters.industry) conditions.push(eq(companies.industry, filters.industry));
  if (filters.serviceId) conditions.push(eq(prospects.serviceId, filters.serviceId));
  if (filters.timezone) conditions.push(eq(companies.timezone, filters.timezone));
  if (filters.createdAfter) conditions.push(gte(prospects.createdAt, filters.createdAfter));
  if (filters.createdBefore) conditions.push(lte(prospects.createdAt, filters.createdBefore));
  if (filters.lastContactedBefore) {
    conditions.push(lte(prospects.lastContactedAt, filters.lastContactedBefore));
  }
  if (filters.followUpDueBefore) {
    conditions.push(isNotNull(prospects.nextFollowUpAt));
    conditions.push(lte(prospects.nextFollowUpAt, filters.followUpDueBefore));
  }

  const where = and(...conditions);

  const orderBy = (() => {
    switch (filters.sort) {
      case 'created':
        return [desc(prospects.createdAt), desc(prospects.id)];
      case 'updated':
        return [desc(prospects.updatedAt), desc(prospects.id)];
      case 'company':
        return [asc(companies.name), desc(prospects.id)];
      case 'score':
      default:
        return [desc(prospects.qualificationScore), desc(prospects.createdAt), desc(prospects.id)];
    }
  })();

  const [rows, countRows] = await Promise.all([
    db
      .select({ prospect: prospects, company: companies, contact: contacts })
      .from(prospects)
      .innerJoin(companies, eq(companies.id, prospects.companyId))
      .innerJoin(contacts, eq(contacts.id, prospects.contactId))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(prospects)
      .innerJoin(companies, eq(companies.id, prospects.companyId))
      .innerJoin(contacts, eq(contacts.id, prospects.contactId))
      .where(where),
  ]);

  const total = countRows[0]?.count ?? 0;

  return {
    items: rows,
    total,
    page: currentPage,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** Load one prospect with its company and contact. Always scoped by user. */
export async function getProspect(
  userId: string,
  prospectId: string,
): Promise<ProspectListItem | null> {
  const rows = await getDb()
    .select({ prospect: prospects, company: companies, contact: contacts })
    .from(prospects)
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Change prospect status through the state machine. An illegal transition is
 * rejected rather than recorded, and every accepted change writes an activity.
 */
export async function changeProspectStatus(
  userId: string,
  prospectId: string,
  to: ProspectStatus,
  options: { reason?: string; actorType?: 'USER' | 'SYSTEM' | 'WEBHOOK' } = {},
  existingTx?: Database,
): Promise<{ ok: boolean; error?: string }> {
  const run = async (tx: Database) => {
    const rows = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
      .limit(1);

    const prospect = rows[0];
    if (!prospect) return { ok: false, error: 'Prospect not found.' };

    const from = prospect.status as ProspectStatus;
    const check = canTransition(from, to);
    if (!check.allowed) return { ok: false, error: check.reason };

    await tx
      .update(prospects)
      .set({
        status: to,
        statusChangedAt: new Date(),
        updatedAt: new Date(),
        ...(to === 'DO_NOT_CONTACT' && options.reason ? { doNotContactReason: options.reason } : {}),
      })
      .where(eq(prospects.id, prospectId));

    await recordActivity(
      {
        userId,
        prospectId,
        type: 'STATUS_CHANGED',
        title: `Status: ${from} → ${to}`,
        body: options.reason ?? null,
        metadata: { from, to },
      },
      tx,
    );

    await recordAudit(
      {
        userId,
        actorType: options.actorType ?? 'USER',
        action: 'PROSPECT_STATUS_CHANGED',
        entityType: 'prospect',
        entityId: prospectId,
        metadata: { from, to, reason: options.reason ?? null },
      },
      tx,
    );

    return { ok: true };
  };

  return existingTx ? run(existingTx) : getDb().transaction(run);
}
