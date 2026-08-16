/**
 * Research workflow. Research is human work; nothing here generates content.
 *
 * Each claim may carry source URLs. A field without a source is rendered as
 * unverified in the review screen — the system never presents an unsourced
 * claim as fact (brief §14).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { prospects, research, researchSources, type Research } from '../db/schema.js';
import { safeUrl } from '../domain/normalize.js';
import { canTransition } from '../domain/status.js';
import { recordActivity, recordAudit } from './audit.js';

/** The ten questions of brief §15, in the order the UI asks them. */
export const RESEARCH_FIELDS = [
  { key: 'companyDescription', question: 'What does the company do?' },
  { key: 'product', question: 'What product do they sell?' },
  { key: 'targetCustomers', question: 'Who are their customers?' },
  { key: 'technologyStack', question: 'What technologies are publicly visible?' },
  { key: 'engineeringTeamSize', question: 'What engineering signals exist?' },
  { key: 'hiringActivity', question: 'Are they hiring?' },
  { key: 'recentProductActivity', question: 'What has recently changed in their product?' },
  { key: 'potentialPainPoint', question: 'What potential problem could I help with?' },
  { key: 'whyRelevant', question: 'Why am I relevant?' },
  { key: 'whyContactingThem', question: 'Why contact this person?' },
  { key: 'reasonForReachingOutNow', question: 'What is my reason for reaching out now?' },
] as const;

export type ResearchFieldKey = (typeof RESEARCH_FIELDS)[number]['key'];

/** Fields that must be answered before a prospect is ready for outreach review. */
const REQUIRED_FOR_REVIEW: ResearchFieldKey[] = [
  'companyDescription',
  'potentialPainPoint',
  'whyRelevant',
  'whyContactingThem',
  'reasonForReachingOutNow',
];

export interface ResearchSourceInput {
  field: string;
  url: string;
  title?: string | null;
  note?: string | null;
}

export interface SaveResearchInput {
  userId: string;
  prospectId: string;
  fields: Partial<Record<ResearchFieldKey | 'additionalNotes', string | null>>;
  sources?: ResearchSourceInput[];
}

export interface ResearchCompleteness {
  answered: ResearchFieldKey[];
  missing: ResearchFieldKey[];
  /** Fields answered but with no supporting source URL. */
  unsourced: ResearchFieldKey[];
  readyForReview: boolean;
  percentComplete: number;
}

export async function getResearch(
  userId: string,
  prospectId: string,
): Promise<{ research: Research; sources: (typeof researchSources.$inferSelect)[] } | null> {
  const db = getDb();

  const ownership = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
    .limit(1);
  if (!ownership[0]) return null;

  const rows = await db.select().from(research).where(eq(research.prospectId, prospectId)).limit(1);
  let row = rows[0];

  if (!row) {
    const inserted = await db
      .insert(research)
      .values({ prospectId })
      .onConflictDoNothing()
      .returning();
    row = inserted[0];
    if (!row) {
      const reread = await db.select().from(research).where(eq(research.prospectId, prospectId)).limit(1);
      row = reread[0];
    }
    if (!row) return null;
  }

  const sources = await db
    .select()
    .from(researchSources)
    .where(eq(researchSources.researchId, row.id));

  return { research: row, sources };
}

export async function saveResearch(
  input: SaveResearchInput,
): Promise<{ ok: true; completeness: ResearchCompleteness } | { ok: false; error: string }> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const ownership = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.id, input.prospectId), eq(prospects.userId, input.userId)))
      .limit(1);

    const prospect = ownership[0];
    if (!prospect) return { ok: false as const, error: 'Prospect not found.' };

    const existing = await tx
      .select()
      .from(research)
      .where(eq(research.prospectId, input.prospectId))
      .limit(1);

    let researchRow = existing[0];
    if (!researchRow) {
      const inserted = await tx.insert(research).values({ prospectId: input.prospectId }).returning();
      researchRow = inserted[0];
      if (!researchRow) return { ok: false as const, error: 'Could not create the research record.' };
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(input.fields)) {
      // Only assign known columns: an unexpected key must never reach the update.
      if (key === 'additionalNotes' || RESEARCH_FIELDS.some((f) => f.key === key)) {
        updates[key] = value === null || value === undefined ? null : String(value).slice(0, 5000);
      }
    }

    await tx.update(research).set(updates).where(eq(research.id, researchRow.id));

    if (input.sources) {
      // Replace the source set wholesale: the form submits the full list.
      await tx.delete(researchSources).where(eq(researchSources.researchId, researchRow.id));

      const validSources = input.sources
        .map((source) => ({ ...source, url: safeUrl(source.url) }))
        .filter((source): source is ResearchSourceInput & { url: string } => Boolean(source.url))
        .slice(0, 100);

      if (validSources.length > 0) {
        await tx.insert(researchSources).values(
          validSources.map((source) => ({
            researchId: researchRow.id,
            field: source.field.slice(0, 100),
            url: source.url,
            title: source.title?.slice(0, 300) ?? null,
            note: source.note?.slice(0, 1000) ?? null,
          })),
        );
      }
    }

    const refreshed = await tx.select().from(research).where(eq(research.id, researchRow.id)).limit(1);
    const sources = await tx
      .select()
      .from(researchSources)
      .where(eq(researchSources.researchId, researchRow.id));

    const completeness = assessCompleteness(refreshed[0] ?? researchRow, sources);

    // Move DISCOVERED/RESEARCHING prospects forward once the essentials exist.
    if (completeness.readyForReview && canTransition(prospect.status, 'READY_FOR_REVIEW').allowed) {
      await tx
        .update(prospects)
        .set({ status: 'READY_FOR_REVIEW', statusChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(prospects.id, input.prospectId));
    } else if (prospect.status === 'DISCOVERED' && canTransition(prospect.status, 'RESEARCHING').allowed) {
      await tx
        .update(prospects)
        .set({ status: 'RESEARCHING', statusChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(prospects.id, input.prospectId));
    }

    await recordActivity(
      {
        userId: input.userId,
        prospectId: input.prospectId,
        type: 'RESEARCH_UPDATED',
        title: 'Research updated',
        body: `${completeness.answered.length}/${RESEARCH_FIELDS.length} questions answered.`,
        metadata: { percentComplete: completeness.percentComplete },
      },
      tx,
    );

    await recordAudit(
      {
        userId: input.userId,
        action: 'RESEARCH_UPDATED',
        entityType: 'research',
        entityId: researchRow.id,
        metadata: { prospectId: input.prospectId, percentComplete: completeness.percentComplete },
      },
      tx,
    );

    return { ok: true as const, completeness };
  });
}

export function assessCompleteness(
  row: Research,
  sources: { field: string }[],
): ResearchCompleteness {
  const sourcedFields = new Set(sources.map((s) => s.field));
  const answered: ResearchFieldKey[] = [];
  const missing: ResearchFieldKey[] = [];
  const unsourced: ResearchFieldKey[] = [];

  for (const field of RESEARCH_FIELDS) {
    const value = row[field.key];
    if (typeof value === 'string' && value.trim().length > 0) {
      answered.push(field.key);
      if (!sourcedFields.has(field.key)) unsourced.push(field.key);
    } else {
      missing.push(field.key);
    }
  }

  const readyForReview = REQUIRED_FOR_REVIEW.every((key) => answered.includes(key));

  return {
    answered,
    missing,
    unsourced,
    readyForReview,
    percentComplete: Math.round((answered.length / RESEARCH_FIELDS.length) * 100),
  };
}

/** Sources grouped by the field they substantiate, for rendering next to each answer. */
export async function getSourcesByField(researchId: string): Promise<Record<string, { url: string; title: string | null }[]>> {
  const rows = await getDb()
    .select()
    .from(researchSources)
    .where(eq(researchSources.researchId, researchId));

  const grouped: Record<string, { url: string; title: string | null }[]> = {};
  for (const row of rows) {
    (grouped[row.field] ??= []).push({ url: row.url, title: row.title });
  }
  return grouped;
}

export async function deleteResearchSources(researchId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .delete(researchSources)
    .where(and(eq(researchSources.researchId, researchId), inArray(researchSources.id, ids)));
}
