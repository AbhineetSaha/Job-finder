/**
 * Discovery service.
 *
 * The single most important property: **discovery never creates a prospect and
 * never sends anything.** Candidates land in `discovered_candidates` for human
 * review. Promotion to a prospect is an explicit act, and even then the
 * prospect still has to be researched, drafted, and approved like any other.
 *
 * Automating the *finding* does not automate the *deciding*.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  companies,
  contacts,
  discoveredCandidates,
  discoveryRuns,
  discoverySources,
  prospects,
  userProfiles,
  type DiscoveredCandidate,
  type DiscoverySource,
} from '../db/schema.js';
import {
  canPromote,
  DEFAULT_GEOGRAPHY_POLICY,
  normalizeCandidate,
  type Contactability,
  type GeographyPolicy,
  type MatchProfile,
} from '../domain/discovery.js';
import { normalizeEmail } from '../domain/normalize.js';
import { getSource, listSources } from '../sources/registry.js';
import { PoliteHttpClient } from '../sources/http.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from './audit.js';
import { createProspect } from './prospects.js';
import { checkSuppression } from './suppression.js';

export interface RunDiscoveryOptions {
  userId: string;
  sourceId: string;
  /** Overrides the source's configured limit for a one-off run. */
  limit?: number;
  minMatchScore?: number;
  geographyPolicy?: GeographyPolicy;
  /** Injected in tests so no network is touched. */
  http?: PoliteHttpClient;
  signal?: AbortSignal;
}

export interface RunDiscoveryResult {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL';
  itemsFetched: number;
  candidatesCreated: number;
  duplicatesSkipped: number;
  excludedByGeography: number;
  belowMatchThreshold: number;
  warnings: string[];
  error: string | null;
}

/** Read the operator's skills and industries for match scoring. */
async function loadMatchProfile(db: Database, userId: string): Promise<MatchProfile> {
  const rows = await db
    .select({ skills: userProfiles.skills, industries: userProfiles.industries })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  return {
    skills: rows[0]?.skills ?? [],
    industries: rows[0]?.industries ?? [],
  };
}

/**
 * Run one configured source and stage what it finds.
 *
 * Failure is recorded on the run rather than thrown, so a broken source shows
 * up in the UI as a failed run instead of a crashed worker.
 */
export async function runDiscovery(options: RunDiscoveryOptions): Promise<RunDiscoveryResult> {
  const db = getDb();

  const sourceRows = await db
    .select()
    .from(discoverySources)
    .where(and(eq(discoverySources.id, options.sourceId), eq(discoverySources.userId, options.userId)))
    .limit(1);

  const sourceRow = sourceRows[0];
  if (!sourceRow) throw new Error('Discovery source not found.');

  const adapter = getSource(sourceRow.kind);
  if (!adapter) throw new Error(`No adapter registered for source kind "${sourceRow.kind}".`);

  const runRows = await db
    .insert(discoveryRuns)
    .values({
      userId: options.userId,
      sourceId: sourceRow.id,
      kind: sourceRow.kind,
      status: 'RUNNING',
      metadata: { config: sourceRow.config },
    })
    .returning();

  const run = runRows[0];
  if (!run) throw new Error('Could not create the discovery run.');

  const result: RunDiscoveryResult = {
    runId: run.id,
    status: 'SUCCEEDED',
    itemsFetched: 0,
    candidatesCreated: 0,
    duplicatesSkipped: 0,
    excludedByGeography: 0,
    belowMatchThreshold: 0,
    warnings: [],
    error: null,
  };

  try {
    const profile = await loadMatchProfile(db, options.userId);
    const http = options.http ?? new PoliteHttpClient();

    const config = {
      ...sourceRow.config,
      ...(options.limit ? { limit: options.limit } : {}),
    };

    const discovered = await adapter.discover({
      http,
      config,
      limit: options.limit ?? 50,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    result.itemsFetched = discovered.itemsFetched;
    result.warnings.push(...discovered.warnings);

    const policy = options.geographyPolicy ?? DEFAULT_GEOGRAPHY_POLICY;
    const minMatchScore =
      options.minMatchScore ?? (Number(sourceRow.config.minMatchScore) || 0);

    for (const raw of discovered.candidates) {
      const outcome = normalizeCandidate(raw, { policy, profile, minMatchScore });

      if (!outcome.keep || !outcome.candidate) {
        if (outcome.reason.includes('exclusion list') || outcome.reason.includes('target country')) {
          result.excludedByGeography += 1;
        } else if (outcome.reason.includes('below the threshold')) {
          result.belowMatchThreshold += 1;
        }
        continue;
      }

      const candidate = outcome.candidate;

      // Already a prospect? Then this is not a lead, it is something already
      // being worked, and staging it again would waste the operator's time.
      const existing = await findExistingProspect(db, options.userId, candidate);
      if (existing) {
        result.duplicatesSkipped += 1;
        continue;
      }

      const inserted = await db
        .insert(discoveredCandidates)
        .values({
          userId: options.userId,
          runId: run.id,
          companyName: candidate.companyName,
          normalizedName: candidate.normalizedName,
          domain: candidate.domain,
          normalizedDomain: candidate.normalizedDomain,
          website: candidate.website,
          description: candidate.description,
          country: candidate.country,
          locationText: candidate.locationText,
          contactability: candidate.contactability,
          technologyStack: candidate.technologyStack,
          fundingSignals: candidate.fundingSignals,
          hiringSignals: candidate.hiringSignals,
          publishedEmail: candidate.publishedEmail,
          contactName: candidate.contactName,
          contactRole: candidate.contactRole,
          matchScore: candidate.matchScore,
          matchReasons: candidate.matchReasons,
          source: sourceRow.kind,
          sourceUrl: candidate.sourceUrl,
          rawPayload: candidate.raw,
        })
        // Re-running a source is idempotent: the same company from the same
        // source updates nothing and creates nothing.
        .onConflictDoNothing({
          target: [
            discoveredCandidates.userId,
            discoveredCandidates.source,
            discoveredCandidates.normalizedName,
          ],
        })
        .returning({ id: discoveredCandidates.id });

      if (inserted[0]) result.candidatesCreated += 1;
      else result.duplicatesSkipped += 1;
    }

    if (result.warnings.length > 0 && result.candidatesCreated === 0) {
      result.status = 'PARTIAL';
    }

    await db
      .update(discoveryRuns)
      .set({
        status: result.status,
        finishedAt: new Date(),
        itemsFetched: result.itemsFetched,
        candidatesCreated: result.candidatesCreated,
        duplicatesSkipped: result.duplicatesSkipped,
        excludedByGeography: result.excludedByGeography,
        belowMatchThreshold: result.belowMatchThreshold,
        metadata: { ...discovered.metadata, warnings: result.warnings },
      })
      .where(eq(discoveryRuns.id, run.id));

    await db
      .update(discoverySources)
      .set({ lastRunAt: new Date(), updatedAt: new Date() })
      .where(eq(discoverySources.id, sourceRow.id));

    await recordAudit({
      userId: options.userId,
      actorType: 'SYSTEM',
      action: 'PROSPECT_IMPORTED',
      entityType: 'discovery_run',
      entityId: run.id,
      metadata: {
        source: sourceRow.kind,
        created: result.candidatesCreated,
        excluded: result.excludedByGeography,
      },
    });

    logger.info('Discovery run complete', {
      event: 'discovery_run',
      userId: options.userId,
      status: result.status,
      runId: result.runId,
      itemsFetched: result.itemsFetched,
      candidatesCreated: result.candidatesCreated,
      duplicatesSkipped: result.duplicatesSkipped,
      excludedByGeography: result.excludedByGeography,
      belowMatchThreshold: result.belowMatchThreshold,
      warningCount: result.warnings.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.status = 'FAILED';
    result.error = message;

    await db
      .update(discoveryRuns)
      .set({ status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(discoveryRuns.id, run.id));

    logger.error('Discovery run failed', {
      event: 'discovery_run_failed',
      userId: options.userId,
      error: message,
    });
  }

  return result;
}

/** Does this candidate correspond to a prospect that already exists? */
async function findExistingProspect(
  db: Database,
  userId: string,
  candidate: { normalizedName: string; normalizedDomain: string | null; publishedEmail: string | null },
): Promise<boolean> {
  const conditions = [eq(companies.normalizedName, candidate.normalizedName)];
  if (candidate.normalizedDomain) {
    conditions.push(eq(companies.normalizedDomain, candidate.normalizedDomain));
  }

  const companyMatch = await db
    .select({ id: companies.id })
    .from(companies)
    .innerJoin(prospects, eq(prospects.companyId, companies.id))
    .where(and(eq(companies.userId, userId), or(...conditions)))
    .limit(1);

  if (companyMatch.length > 0) return true;

  if (candidate.publishedEmail) {
    const contactMatch = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.normalizedEmail, candidate.publishedEmail)))
      .limit(1);
    if (contactMatch.length > 0) return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Source management                                                          */
/* -------------------------------------------------------------------------- */

export interface CreateSourceInput {
  userId: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
}

export async function createDiscoverySource(
  input: CreateSourceInput,
): Promise<{ ok: true; source: DiscoverySource } | { ok: false; error: string }> {
  const adapter = getSource(input.kind);
  if (!adapter) return { ok: false, error: `Unknown source kind "${input.kind}".` };
  if (!input.name.trim()) return { ok: false, error: 'A name is required.' };

  try {
    const rows = await getDb()
      .insert(discoverySources)
      .values({
        userId: input.userId,
        kind: input.kind,
        name: input.name.trim(),
        config: input.config,
      })
      .returning();

    const source = rows[0];
    if (!source) return { ok: false, error: 'Could not create the source.' };
    return { ok: true, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('duplicate key')) {
      return { ok: false, error: 'A source with that name already exists.' };
    }
    return { ok: false, error: 'Could not create the source.' };
  }
}

export async function listDiscoverySources(userId: string) {
  return getDb()
    .select()
    .from(discoverySources)
    .where(eq(discoverySources.userId, userId))
    .orderBy(desc(discoverySources.createdAt));
}

export async function listDiscoveryRuns(userId: string, limit = 20) {
  return getDb()
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.userId, userId))
    .orderBy(desc(discoveryRuns.startedAt))
    .limit(limit);
}

export async function deleteDiscoverySource(userId: string, sourceId: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(discoverySources)
    .where(and(eq(discoverySources.id, sourceId), eq(discoverySources.userId, userId)))
    .returning({ id: discoverySources.id });
  return deleted.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Candidate review                                                           */
/* -------------------------------------------------------------------------- */

export interface CandidateFilters {
  status?: 'NEW' | 'PROMOTED' | 'REJECTED' | 'DUPLICATE';
  minMatchScore?: number;
  source?: string;
  country?: string;
  contactability?: Contactability;
  hasEmail?: boolean;
  hasFunding?: boolean;
}

export async function listCandidates(
  userId: string,
  filters: CandidateFilters = {},
  page = 1,
  pageSize = 25,
) {
  const db = getDb();
  const limit = Math.min(Math.max(1, pageSize), 100);
  const offset = (Math.max(1, page) - 1) * limit;

  const conditions = [eq(discoveredCandidates.userId, userId)];
  if (filters.status) conditions.push(eq(discoveredCandidates.status, filters.status));
  if (typeof filters.minMatchScore === 'number') {
    conditions.push(sql`${discoveredCandidates.matchScore} >= ${filters.minMatchScore}`);
  }
  if (filters.source) conditions.push(eq(discoveredCandidates.source, filters.source));
  if (filters.country) conditions.push(eq(discoveredCandidates.country, filters.country));
  if (filters.contactability) {
    conditions.push(eq(discoveredCandidates.contactability, filters.contactability));
  }
  if (filters.hasEmail === true) {
    conditions.push(sql`${discoveredCandidates.publishedEmail} is not null`);
  }
  if (filters.hasEmail === false) conditions.push(isNull(discoveredCandidates.publishedEmail));
  if (filters.hasFunding) {
    conditions.push(sql`jsonb_array_length(${discoveredCandidates.fundingSignals}) > 0`);
  }

  const where = and(...conditions);

  const [items, countRows] = await Promise.all([
    db
      .select()
      .from(discoveredCandidates)
      .where(where)
      .orderBy(desc(discoveredCandidates.matchScore), desc(discoveredCandidates.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(discoveredCandidates)
      .where(where),
  ]);

  const total = countRows[0]?.count ?? 0;

  return {
    items,
    total,
    page: Math.max(1, page),
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getCandidate(
  userId: string,
  candidateId: string,
): Promise<DiscoveredCandidate | null> {
  const rows = await getDb()
    .select()
    .from(discoveredCandidates)
    .where(
      and(eq(discoveredCandidates.id, candidateId), eq(discoveredCandidates.userId, userId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface PromoteInput {
  userId: string;
  candidateId: string;
  /** Required when the candidate carries no published address. */
  contactEmail?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  contactReason?: string | null;
  /** Must be true to promote a candidate in a consent-based jurisdiction. */
  acknowledgedConsentRisk?: boolean;
}

/**
 * Promote a candidate to a real prospect.
 *
 * This is the only path out of the staging table, and it applies the same
 * suppression and validation rules as any other prospect creation.
 */
export async function promoteCandidate(
  input: PromoteInput,
): Promise<{ ok: true; prospectId: string } | { ok: false; error: string }> {
  const db = getDb();

  const candidate = await getCandidate(input.userId, input.candidateId);
  if (!candidate) return { ok: false, error: 'Candidate not found.' };
  if (candidate.status === 'PROMOTED') {
    return { ok: false, error: 'This candidate has already been promoted.' };
  }

  const email = normalizeEmail(input.contactEmail ?? candidate.publishedEmail);

  const gate = canPromote(
    {
      contactability: candidate.contactability as Contactability,
      publishedEmail: candidate.publishedEmail,
    },
    {
      contactEmail: input.contactEmail ?? null,
      ...(input.acknowledgedConsentRisk !== undefined
        ? { acknowledgedConsentRisk: input.acknowledgedConsentRisk }
        : {}),
    },
  );
  if (!gate.ok) return { ok: false, error: gate.reason };
  if (!email) return { ok: false, error: 'A contact email address is required.' };

  // Suppression applies to discovery too: a person who unsubscribed must not
  // reappear as a fresh prospect because a source rediscovered their company.
  const suppression = await checkSuppression(input.userId, email);
  if (suppression.emailSuppressed || suppression.domainSuppressed) {
    await db
      .update(discoveredCandidates)
      .set({
        status: 'REJECTED',
        reviewNote: `Suppressed: ${suppression.detail ?? 'on the suppression list'}`,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(discoveredCandidates.id, candidate.id));

    return {
      ok: false,
      error: `${email} is on the suppression list. The candidate has been rejected.`,
    };
  }

  const created = await createProspect({
    userId: input.userId,
    source: `DISCOVERY:${candidate.source}`,
    companyName: candidate.companyName,
    website: candidate.website,
    contactName: input.contactName ?? candidate.contactName,
    contactRole: input.contactRole ?? candidate.contactRole,
    contactEmail: email,
    contactReason: input.contactReason ?? null,
    sourceUrl: candidate.sourceUrl,
    country: candidate.country ?? 'US',
    companyDescription: candidate.description,
    technologyStack: candidate.technologyStack,
    notes: [
      `Discovered via ${candidate.source}.`,
      candidate.fundingSignals.length > 0 ? `Funding: ${candidate.fundingSignals.join('; ')}` : null,
      candidate.hiringSignals.length > 0 ? `Hiring: ${candidate.hiringSignals.join('; ')}` : null,
      `Match ${candidate.matchScore}/100 — ${candidate.matchReasons.join(' · ')}`,
    ]
      .filter(Boolean)
      .join('\n'),
  });

  if (!created.ok) {
    // A duplicate is a legitimate outcome: mark the candidate accordingly
    // rather than leaving it in the queue to be tried again.
    if (created.duplicateOf) {
      await db
        .update(discoveredCandidates)
        .set({
          status: 'DUPLICATE',
          reviewNote: created.error,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          ...(created.duplicateOf.prospectId
            ? { promotedProspectId: created.duplicateOf.prospectId }
            : {}),
        })
        .where(eq(discoveredCandidates.id, candidate.id));
    }
    return { ok: false, error: created.error };
  }

  await db
    .update(discoveredCandidates)
    .set({
      status: 'PROMOTED',
      promotedProspectId: created.prospect.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(discoveredCandidates.id, candidate.id));

  await recordAudit({
    userId: input.userId,
    action: 'PROSPECT_CREATED',
    entityType: 'discovered_candidate',
    entityId: candidate.id,
    metadata: {
      prospectId: created.prospect.id,
      source: candidate.source,
      contactability: candidate.contactability,
      acknowledgedConsentRisk: Boolean(input.acknowledgedConsentRisk),
    },
  });

  return { ok: true, prospectId: created.prospect.id };
}

export async function rejectCandidate(
  userId: string,
  candidateId: string,
  note: string,
): Promise<{ ok: boolean; error?: string }> {
  const updated = await getDb()
    .update(discoveredCandidates)
    .set({
      status: 'REJECTED',
      reviewNote: note.slice(0, 1000),
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(discoveredCandidates.id, candidateId), eq(discoveredCandidates.userId, userId)),
    )
    .returning({ id: discoveredCandidates.id });

  return updated.length > 0 ? { ok: true } : { ok: false, error: 'Candidate not found.' };
}

export async function rejectCandidates(
  userId: string,
  candidateIds: string[],
  note: string,
): Promise<number> {
  if (candidateIds.length === 0) return 0;
  const updated = await getDb()
    .update(discoveredCandidates)
    .set({
      status: 'REJECTED',
      reviewNote: note.slice(0, 1000),
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(discoveredCandidates.userId, userId),
        inArray(discoveredCandidates.id, candidateIds),
      ),
    )
    .returning({ id: discoveredCandidates.id });
  return updated.length;
}

/** Counts for the discovery dashboard. */
export async function getDiscoveryCounts(userId: string) {
  const rows = await getDb()
    .select({ status: discoveredCandidates.status, count: sql<number>`count(*)::int` })
    .from(discoveredCandidates)
    .where(eq(discoveredCandidates.userId, userId))
    .groupBy(discoveredCandidates.status);

  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = row.count;

  return {
    new: byStatus.NEW ?? 0,
    promoted: byStatus.PROMOTED ?? 0,
    rejected: byStatus.REJECTED ?? 0,
    duplicate: byStatus.DUPLICATE ?? 0,
  };
}

export { listSources };
