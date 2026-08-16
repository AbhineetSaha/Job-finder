/**
 * Qualification scoring service.
 *
 * A re-score inserts a new `qualification_scores` row rather than updating one,
 * so the history of why a prospect was scored a given way survives a change to
 * the weights.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import { prospects, qualificationScores } from '../db/schema.js';
import {
  coerceSignals,
  scoreProspect,
  type QualificationResult,
  type QualificationSignals,
} from '../domain/qualification.js';
import { canTransition } from '../domain/status.js';
import { recordActivity, recordAudit } from './audit.js';
import { getConfig } from './config.js';

export async function qualifyProspect(
  userId: string,
  prospectId: string,
  rawSignals: Record<string, unknown>,
  existingTx?: Database,
): Promise<{ ok: true; result: QualificationResult } | { ok: false; error: string }> {
  const config = await getConfig(userId);
  const signals = coerceSignals(rawSignals);
  const result = scoreProspect(signals, config.qualificationWeights);

  const run = async (tx: Database) => {
    const rows = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
      .limit(1);

    const prospect = rows[0];
    if (!prospect) return { ok: false as const, error: 'Prospect not found.' };

    await tx.insert(qualificationScores).values({
      prospectId,
      score: result.score,
      band: result.band,
      reasons: result.reasons,
      signals: signals as unknown as Record<string, string>,
      weightsVersion: result.weightsVersion,
    });

    // Advance to QUALIFIED when the state machine permits it. Scoring a
    // prospect that has already been contacted must not rewind its status.
    const shouldAdvance = canTransition(prospect.status, 'QUALIFIED').allowed;

    await tx
      .update(prospects)
      .set({
        qualificationScore: result.score,
        qualificationBand: result.band,
        updatedAt: new Date(),
        ...(shouldAdvance
          ? { status: 'QUALIFIED' as const, statusChangedAt: new Date() }
          : {}),
      })
      .where(eq(prospects.id, prospectId));

    await recordActivity(
      {
        userId,
        prospectId,
        type: 'QUALIFIED',
        title: `Scored ${result.score}/100 — ${result.band}`,
        body: result.reasons
          .filter((r) => r.points > 0)
          .map((r) => `${r.label} (+${r.points})`)
          .join('\n'),
        metadata: { score: result.score, band: result.band, unknown: result.unknownSignals },
      },
      tx,
    );

    await recordAudit(
      {
        userId,
        action: 'PROSPECT_QUALIFIED',
        entityType: 'prospect',
        entityId: prospectId,
        metadata: { score: result.score, band: result.band, signals },
      },
      tx,
    );

    return { ok: true as const, result };
  };

  return existingTx ? run(existingTx) : getDb().transaction(run);
}

/** The signals last used, so the form re-opens where the operator left it. */
export async function getLatestSignals(prospectId: string): Promise<QualificationSignals> {
  const rows = await getDb()
    .select()
    .from(qualificationScores)
    .where(eq(qualificationScores.prospectId, prospectId))
    .orderBy(desc(qualificationScores.computedAt))
    .limit(1);

  return coerceSignals(rows[0]?.signals ?? null);
}

export async function getScoreHistory(prospectId: string, limit = 10) {
  return getDb()
    .select()
    .from(qualificationScores)
    .where(eq(qualificationScores.prospectId, prospectId))
    .orderBy(desc(qualificationScores.computedAt))
    .limit(limit);
}
