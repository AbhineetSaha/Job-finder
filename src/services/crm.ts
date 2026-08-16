/**
 * CRM: pipeline, meetings, deals, and the conversation timeline.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  activities,
  companies,
  contacts,
  deals,
  meetings,
  messages,
  prospects,
  replies,
  type Deal,
  type Meeting,
} from '../db/schema.js';
import { isValidTimeZone } from '../domain/timezone.js';
import { safeUrl } from '../domain/normalize.js';
import { pipelineStage, type PipelineStage, type ProspectStatus } from '../domain/status.js';
import { recordActivity, recordAudit } from './audit.js';
import { changeProspectStatus } from './prospects.js';
import { stopSequence } from './campaigns.js';

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* -------------------------------------------------------------------------- */

export interface PipelineCard {
  prospectId: string;
  companyName: string;
  contactName: string;
  contactRole: string | null;
  status: ProspectStatus;
  stage: PipelineStage;
  score: number | null;
  estimatedValue: string | null;
  lastContactedAt: Date | null;
  nextFollowUpAt: Date | null;
}

export async function getPipeline(userId: string): Promise<Record<PipelineStage, PipelineCard[]>> {
  const rows = await getDb()
    .select({
      prospectId: prospects.id,
      status: prospects.status,
      score: prospects.qualificationScore,
      lastContactedAt: prospects.lastContactedAt,
      nextFollowUpAt: prospects.nextFollowUpAt,
      companyName: companies.name,
      contactName: contacts.fullName,
      contactRole: contacts.role,
      estimatedValue: deals.estimatedValue,
    })
    .from(prospects)
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .leftJoin(deals, eq(deals.prospectId, prospects.id))
    .where(eq(prospects.userId, userId))
    .orderBy(desc(prospects.qualificationScore), desc(prospects.updatedAt))
    .limit(1000);

  const board: Record<PipelineStage, PipelineCard[]> = {
    NEW: [],
    QUALIFIED: [],
    CONTACTED: [],
    REPLIED: [],
    MEETING: [],
    PROPOSAL: [],
    NEGOTIATION: [],
    WON: [],
    LOST: [],
  };

  for (const row of rows) {
    const status = row.status as ProspectStatus;
    const stage = pipelineStage(status);
    board[stage].push({
      prospectId: row.prospectId,
      companyName: row.companyName,
      contactName: row.contactName,
      contactRole: row.contactRole,
      status,
      stage,
      score: row.score,
      estimatedValue: row.estimatedValue,
      lastContactedAt: row.lastContactedAt,
      nextFollowUpAt: row.nextFollowUpAt,
    });
  }

  return board;
}

/* -------------------------------------------------------------------------- */
/* Meetings                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateMeetingInput {
  userId: string;
  prospectId: string;
  scheduledFor: Date;
  timezone: string;
  meetingUrl?: string | null;
  notes?: string | null;
}

/**
 * Book a meeting. Booking is a sequence stop condition (brief §27): continuing
 * to send follow-ups to someone who has agreed to talk is the single most
 * embarrassing failure this system could have.
 */
export async function createMeeting(
  input: CreateMeetingInput,
): Promise<{ ok: true; meeting: Meeting } | { ok: false; error: string }> {
  if (!isValidTimeZone(input.timezone)) return { ok: false, error: 'Invalid time zone.' };
  if (Number.isNaN(input.scheduledFor.getTime())) return { ok: false, error: 'Invalid meeting time.' };

  const db = getDb();

  const owned = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.id, input.prospectId), eq(prospects.userId, input.userId)))
    .limit(1);
  if (!owned[0]) return { ok: false, error: 'Prospect not found.' };

  const meeting = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(meetings)
      .values({
        userId: input.userId,
        prospectId: input.prospectId,
        scheduledFor: input.scheduledFor,
        timezone: input.timezone,
        meetingUrl: safeUrl(input.meetingUrl),
        notes: input.notes ?? null,
        status: 'SCHEDULED',
      })
      .returning();

    const created = inserted[0];
    if (!created) throw new Error('Could not create the meeting.');

    await recordActivity(
      {
        userId: input.userId,
        prospectId: input.prospectId,
        type: 'MEETING_BOOKED',
        title: `Meeting booked for ${input.scheduledFor.toISOString()}`,
        metadata: { meetingId: created.id, timezone: input.timezone },
      },
      tx,
    );

    await recordAudit(
      {
        userId: input.userId,
        action: 'MEETING_CREATED',
        entityType: 'meeting',
        entityId: created.id,
        metadata: { prospectId: input.prospectId },
      },
      tx,
    );

    await stopSequence(input.userId, input.prospectId, 'MEETING_BOOKED', 'Meeting booked.', tx);

    return created;
  });

  await changeProspectStatus(input.userId, input.prospectId, 'MEETING_BOOKED');

  return { ok: true, meeting };
}

export async function updateMeeting(
  userId: string,
  meetingId: string,
  changes: {
    status?: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
    notes?: string | null;
    outcome?: string | null;
    nextAction?: string | null;
    scheduledFor?: Date;
  },
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();

  const rows = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
    .limit(1);
  if (!rows[0]) return { ok: false, error: 'Meeting not found.' };

  await db
    .update(meetings)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(meetings.id, meetingId));

  await recordAudit({
    userId,
    action: 'MEETING_UPDATED',
    entityType: 'meeting',
    entityId: meetingId,
    metadata: { changes: Object.keys(changes) },
  });

  return { ok: true };
}

export async function listUpcomingMeetings(userId: string, limit = 20) {
  return getDb()
    .select({ meeting: meetings, prospect: prospects, company: companies, contact: contacts })
    .from(meetings)
    .innerJoin(prospects, eq(prospects.id, meetings.prospectId))
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(and(eq(meetings.userId, userId), eq(meetings.status, 'SCHEDULED')))
    .orderBy(meetings.scheduledFor)
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* Deals                                                                      */
/* -------------------------------------------------------------------------- */

export interface UpsertDealInput {
  userId: string;
  prospectId: string;
  estimatedValue?: string | null;
  currency?: string;
  proposalDate?: Date | null;
  expectedCloseDate?: Date | null;
  contractType?: 'HOURLY' | 'FIXED' | 'RETAINER' | null;
  hourlyRate?: string | null;
  estimatedHours?: number | null;
  retainerValue?: string | null;
  notes?: string | null;
}

export async function upsertDeal(
  input: UpsertDealInput,
): Promise<{ ok: true; deal: Deal } | { ok: false; error: string }> {
  const db = getDb();

  const owned = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.id, input.prospectId), eq(prospects.userId, input.userId)))
    .limit(1);
  if (!owned[0]) return { ok: false, error: 'Prospect not found.' };

  const values = {
    userId: input.userId,
    prospectId: input.prospectId,
    estimatedValue: input.estimatedValue ?? null,
    currency: input.currency ?? 'USD',
    proposalDate: input.proposalDate ?? null,
    expectedCloseDate: input.expectedCloseDate ?? null,
    contractType: input.contractType ?? null,
    hourlyRate: input.hourlyRate ?? null,
    estimatedHours: input.estimatedHours ?? null,
    retainerValue: input.retainerValue ?? null,
    notes: input.notes ?? null,
    updatedAt: new Date(),
  };

  const rows = await db
    .insert(deals)
    .values(values)
    .onConflictDoUpdate({ target: deals.prospectId, set: values })
    .returning();

  const deal = rows[0];
  if (!deal) return { ok: false, error: 'Could not save the deal.' };

  await recordAudit({
    userId: input.userId,
    action: 'DEAL_UPDATED',
    entityType: 'deal',
    entityId: deal.id,
    metadata: { prospectId: input.prospectId, estimatedValue: input.estimatedValue },
  });

  return { ok: true, deal };
}

export async function closeDeal(
  userId: string,
  prospectId: string,
  outcome: 'WON' | 'LOST',
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();

  const rows = await db
    .select()
    .from(deals)
    .where(and(eq(deals.prospectId, prospectId), eq(deals.userId, userId)))
    .limit(1);

  const deal = rows[0];
  if (!deal) return { ok: false, error: 'No deal exists for this prospect.' };

  await db
    .update(deals)
    .set({ status: outcome, closedAt: new Date(), updatedAt: new Date(), notes: note ?? deal.notes })
    .where(eq(deals.id, deal.id));

  await recordActivity({
    userId,
    prospectId,
    type: outcome === 'WON' ? 'DEAL_WON' : 'DEAL_LOST',
    title: outcome === 'WON' ? 'Deal won' : 'Deal lost',
    body: note ?? null,
    metadata: { dealId: deal.id, value: deal.estimatedValue },
  });

  await recordAudit({
    userId,
    action: outcome === 'WON' ? 'DEAL_WON' : 'DEAL_LOST',
    entityType: 'deal',
    entityId: deal.id,
    metadata: { prospectId, value: deal.estimatedValue },
  });

  const statusResult = await changeProspectStatus(userId, prospectId, outcome);
  if (!statusResult.ok) return statusResult;

  return { ok: true };
}

export async function getDeal(userId: string, prospectId: string): Promise<Deal | null> {
  const rows = await getDb()
    .select()
    .from(deals)
    .where(and(eq(deals.prospectId, prospectId), eq(deals.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Conversation view                                                          */
/* -------------------------------------------------------------------------- */

export interface ConversationEntry {
  kind: 'OUTBOUND' | 'INBOUND' | 'ACTIVITY';
  at: Date;
  title: string;
  body: string | null;
  status?: string;
  id: string;
}

/** A single chronological thread of everything that happened with a prospect. */
export async function getConversation(
  userId: string,
  prospectId: string,
): Promise<ConversationEntry[]> {
  const db = getDb();

  const [outbound, inbound, timeline] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.prospectId, prospectId)))
      .orderBy(messages.createdAt)
      .limit(200),
    db
      .select()
      .from(replies)
      .where(and(eq(replies.userId, userId), eq(replies.prospectId, prospectId)))
      .orderBy(replies.receivedAt)
      .limit(200),
    db
      .select()
      .from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.prospectId, prospectId)))
      .orderBy(activities.occurredAt)
      .limit(300),
  ]);

  const entries: ConversationEntry[] = [
    ...outbound.map((m) => ({
      kind: 'OUTBOUND' as const,
      at: m.sentAt ?? m.scheduledAt ?? m.createdAt,
      title: m.subject,
      body: m.bodyText,
      status: m.status,
      id: m.id,
    })),
    ...inbound.map((r) => ({
      kind: 'INBOUND' as const,
      at: r.receivedAt,
      title: r.subject ?? 'Reply',
      body: r.bodyText,
      status: r.classification,
      id: r.id,
    })),
    ...timeline.map((a) => ({
      kind: 'ACTIVITY' as const,
      at: a.occurredAt,
      title: a.title,
      body: a.body,
      status: a.type,
      id: a.id,
    })),
  ];

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Dashboard counts: "what needs my attention today?" */
export async function getDashboardCounts(userId: string) {
  const db = getDb();
  const now = new Date();

  const [awaitingResearch, awaitingApproval, scheduled, followUpsDue, unreadReplies, upcomingMeetings, pipelineValue] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(prospects)
        .where(
          and(eq(prospects.userId, userId), sql`${prospects.status} in ('DISCOVERED','RESEARCHING')`),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.userId, userId), eq(messages.status, 'PENDING_APPROVAL'))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(eq(messages.userId, userId), sql`${messages.status} in ('APPROVED','SCHEDULED','QUEUED')`),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(prospects)
        .where(and(eq(prospects.userId, userId), sql`${prospects.nextFollowUpAt} <= ${now}`)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(replies)
        .where(and(eq(replies.userId, userId), sql`${replies.readAt} is null`)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(meetings)
        .where(
          and(
            eq(meetings.userId, userId),
            eq(meetings.status, 'SCHEDULED'),
            sql`${meetings.scheduledFor} >= ${now}`,
          ),
        ),
      db
        .select({ total: sql<string>`coalesce(sum(${deals.estimatedValue}), 0)::text` })
        .from(deals)
        .where(and(eq(deals.userId, userId), eq(deals.status, 'OPEN'))),
    ]);

  return {
    awaitingResearch: awaitingResearch[0]?.count ?? 0,
    awaitingApproval: awaitingApproval[0]?.count ?? 0,
    scheduled: scheduled[0]?.count ?? 0,
    followUpsDue: followUpsDue[0]?.count ?? 0,
    unreadReplies: unreadReplies[0]?.count ?? 0,
    upcomingMeetings: upcomingMeetings[0]?.count ?? 0,
    openPipelineValue: pipelineValue[0]?.total ?? '0',
  };
}
