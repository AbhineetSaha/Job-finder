/**
 * Analytics. All aggregation happens in SQL — no endpoint loads rows to count
 * them in JavaScript (brief §68).
 *
 * The metric ordering here is deliberate. Sends and deliveries are recorded but
 * demoted; positive replies, meetings, proposals, wins and revenue are the
 * numbers that decide whether the outreach is working (brief §39).
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { campaignMembers, campaigns, deals, meetings, messages, prospects, replies } from '../db/schema.js';

export interface ProspectMetrics {
  total: number;
  qualified: number;
  highPriority: number;
  contacted: number;
  researched: number;
}

export interface OutreachMetrics {
  sent: number;
  delivered: number;
  bounced: number;
  blocked: number;
  failed: number;
  replies: number;
  positiveReplies: number;
  meetings: number;
}

export interface SalesMetrics {
  proposals: number;
  won: number;
  lost: number;
  revenue: string;
  expectedRevenue: string;
  averageDealSize: string;
}

export interface ConversionMetrics {
  qualificationRate: number;
  approvalRate: number;
  deliveryRate: number;
  replyRate: number;
  positiveReplyRate: number;
  meetingRate: number;
  proposalRate: number;
  closeRate: number;
  revenuePerProspect: string;
}

export interface AnalyticsSnapshot {
  prospects: ProspectMetrics;
  outreach: OutreachMetrics;
  sales: SalesMetrics;
  conversion: ConversionMetrics;
  since: Date | null;
}

/** Percentage to one decimal place; a zero denominator is 0, not NaN. */
function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function money(value: string | null | undefined): string {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '0.00';
}

export async function getAnalytics(userId: string, since?: Date): Promise<AnalyticsSnapshot> {
  const db = getDb();
  const sinceFilter = since ? [gte(prospects.createdAt, since)] : [];

  const prospectRow = await db
    .select({
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where ${prospects.qualificationScore} >= 60)::int`,
      highPriority: sql<number>`count(*) filter (where ${prospects.qualificationScore} >= 90)::int`,
      researched: sql<number>`count(*) filter (where ${prospects.status} not in ('DISCOVERED'))::int`,
      contacted: sql<number>`count(*) filter (where ${prospects.lastContactedAt} is not null)::int`,
    })
    .from(prospects)
    .where(and(eq(prospects.userId, userId), ...sinceFilter));

  const messageRow = await db
    .select({
      sent: sql<number>`count(*) filter (where ${messages.status} in ('SENT','DELIVERED','BOUNCED'))::int`,
      delivered: sql<number>`count(*) filter (where ${messages.status} = 'DELIVERED')::int`,
      bounced: sql<number>`count(*) filter (where ${messages.status} = 'BOUNCED')::int`,
      blocked: sql<number>`count(*) filter (where ${messages.status} = 'BLOCKED')::int`,
      failed: sql<number>`count(*) filter (where ${messages.status} = 'FAILED')::int`,
      drafted: sql<number>`count(*)::int`,
      approved: sql<number>`count(*) filter (where ${messages.status} not in ('DRAFT','PENDING_APPROVAL','CANCELLED'))::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.direction, 'OUTBOUND'),
        ...(since ? [gte(messages.createdAt, since)] : []),
      ),
    );

  const replyRow = await db
    .select({
      total: sql<number>`count(*)::int`,
      positive: sql<number>`count(*) filter (where ${replies.classification} in ('POSITIVE','INTERESTED'))::int`,
    })
    .from(replies)
    .where(and(eq(replies.userId, userId), ...(since ? [gte(replies.receivedAt, since)] : [])));

  const meetingRow = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(meetings)
    .where(and(eq(meetings.userId, userId), ...(since ? [gte(meetings.createdAt, since)] : [])));

  const dealRow = await db
    .select({
      proposals: sql<number>`count(*) filter (where ${deals.proposalDate} is not null)::int`,
      won: sql<number>`count(*) filter (where ${deals.status} = 'WON')::int`,
      lost: sql<number>`count(*) filter (where ${deals.status} = 'LOST')::int`,
      revenue: sql<string>`coalesce(sum(${deals.estimatedValue}) filter (where ${deals.status} = 'WON'), 0)::text`,
      expected: sql<string>`coalesce(sum(${deals.estimatedValue}) filter (where ${deals.status} = 'OPEN'), 0)::text`,
      wonCount: sql<number>`count(*) filter (where ${deals.status} = 'WON')::int`,
    })
    .from(deals)
    .where(and(eq(deals.userId, userId), ...(since ? [gte(deals.createdAt, since)] : [])));

  const p = prospectRow[0] ?? { total: 0, qualified: 0, highPriority: 0, researched: 0, contacted: 0 };
  const m = messageRow[0] ?? {
    sent: 0,
    delivered: 0,
    bounced: 0,
    blocked: 0,
    failed: 0,
    drafted: 0,
    approved: 0,
  };
  const r = replyRow[0] ?? { total: 0, positive: 0 };
  const mt = meetingRow[0] ?? { total: 0 };
  const d = dealRow[0] ?? {
    proposals: 0,
    won: 0,
    lost: 0,
    revenue: '0',
    expected: '0',
    wonCount: 0,
  };

  const revenue = Number(d.revenue ?? 0);
  const closedTotal = d.won + d.lost;

  return {
    prospects: {
      total: p.total,
      qualified: p.qualified,
      highPriority: p.highPriority,
      contacted: p.contacted,
      researched: p.researched,
    },
    outreach: {
      sent: m.sent,
      delivered: m.delivered,
      bounced: m.bounced,
      blocked: m.blocked,
      failed: m.failed,
      replies: r.total,
      positiveReplies: r.positive,
      meetings: mt.total,
    },
    sales: {
      proposals: d.proposals,
      won: d.won,
      lost: d.lost,
      revenue: money(d.revenue),
      expectedRevenue: money(d.expected),
      averageDealSize: d.wonCount > 0 ? money(String(revenue / d.wonCount)) : '0.00',
    },
    conversion: {
      qualificationRate: rate(p.qualified, p.total),
      approvalRate: rate(m.approved, m.drafted),
      // Delivery rate is measured against sends the provider accepted; a
      // provider that reports no delivery events leaves this at 0, which is
      // honest rather than optimistic.
      deliveryRate: rate(m.delivered, m.sent),
      replyRate: rate(r.total, m.sent),
      positiveReplyRate: rate(r.positive, m.sent),
      meetingRate: rate(mt.total, m.sent),
      proposalRate: rate(d.proposals, mt.total),
      closeRate: rate(d.won, closedTotal),
      revenuePerProspect: p.total > 0 ? money(String(revenue / p.total)) : '0.00',
    },
    since: since ?? null,
  };
}

export interface CampaignPerformance {
  campaignId: string;
  name: string;
  status: string;
  enrolled: number;
  sent: number;
  replies: number;
  positiveReplies: number;
  meetings: number;
  replyRate: number;
  positiveReplyRate: number;
}

/**
 * Per-campaign performance, which is how the manual experimentation in
 * brief §40 is evaluated. Nothing is optimised automatically.
 */
export async function getCampaignPerformance(userId: string): Promise<CampaignPerformance[]> {
  const rows = await getDb()
    .select({
      campaignId: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      enrolled: sql<number>`count(distinct ${campaignMembers.id})::int`,
      sent: sql<number>`count(distinct ${messages.id}) filter (where ${messages.status} in ('SENT','DELIVERED','BOUNCED'))::int`,
      replies: sql<number>`count(distinct ${replies.id})::int`,
      positiveReplies: sql<number>`count(distinct ${replies.id}) filter (where ${replies.classification} in ('POSITIVE','INTERESTED'))::int`,
      meetings: sql<number>`count(distinct ${meetings.id})::int`,
    })
    .from(campaigns)
    .leftJoin(campaignMembers, eq(campaignMembers.campaignId, campaigns.id))
    .leftJoin(messages, eq(messages.campaignMemberId, campaignMembers.id))
    .leftJoin(replies, eq(replies.prospectId, campaignMembers.prospectId))
    .leftJoin(meetings, eq(meetings.prospectId, campaignMembers.prospectId))
    .where(eq(campaigns.userId, userId))
    .groupBy(campaigns.id, campaigns.name, campaigns.status)
    .orderBy(campaigns.createdAt);

  return rows.map((row) => ({
    ...row,
    replyRate: rate(row.replies, row.sent),
    positiveReplyRate: rate(row.positiveReplies, row.sent),
  }));
}

/** Daily send volume for the last N days, for the operations chart. */
export async function getDailySendVolume(userId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return getDb()
    .select({
      day: sql<string>`date_trunc('day', ${messages.sentAt})::date::text`,
      sent: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(and(eq(messages.userId, userId), gte(messages.sentAt, since)))
    .groupBy(sql`date_trunc('day', ${messages.sentAt})`)
    .orderBy(sql`date_trunc('day', ${messages.sentAt})`);
}
