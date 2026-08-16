/**
 * Campaigns, sequences, and stop conditions.
 *
 * Stop conditions are enforced server-side (brief §27): stopping a sequence
 * updates the enrolment row, and the send preflight independently re-checks
 * enrolment status, so a queued job for a stopped sequence still cannot send.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  campaignMembers,
  campaignSteps,
  campaigns,
  companies,
  contacts,
  messages,
  prospects,
  templates,
  type Campaign,
  type CampaignStep,
} from '../db/schema.js';
import { isValidTimeZone } from '../domain/timezone.js';
import { normalizeSendDays, normalizeWindows, nextWindowStart, type SendingWindow } from '../domain/window.js';
import { isContactable, type ProspectStatus } from '../domain/status.js';
import { recordActivity, recordAudit } from './audit.js';
import { checkSuppression } from './suppression.js';
import { getConfig } from './config.js';
import { logger } from '../lib/logger.js';

export type CampaignStatus = 'DRAFT' | 'READY' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';

export type StopReason =
  | 'REPLY_RECEIVED'
  | 'MEETING_BOOKED'
  | 'NOT_INTERESTED'
  | 'DO_NOT_CONTACT'
  | 'BOUNCED'
  | 'SUPPRESSED'
  | 'CAMPAIGN_PAUSED'
  | 'MANUALLY_REMOVED'
  | 'SEQUENCE_COMPLETED';

const ALLOWED_CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['READY', 'ARCHIVED'],
  READY: ['RUNNING', 'DRAFT', 'ARCHIVED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'ARCHIVED'],
  PAUSED: ['RUNNING', 'COMPLETED', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

export interface CreateCampaignInput {
  userId: string;
  name: string;
  description?: string;
  serviceId?: string | null;
  timezone: string;
  sendingWindows: SendingWindow[];
  sendDays: number[];
  dailyLimit?: number | null;
  hourlyLimit?: number | null;
  targetCriteria?: Record<string, unknown>;
  steps: { delayDays: number; delayHours?: number; templateId: string; enabled?: boolean }[];
}

export async function createCampaign(
  input: CreateCampaignInput,
): Promise<{ ok: true; campaign: Campaign } | { ok: false; error: string }> {
  if (!input.name.trim()) return { ok: false, error: 'Campaign name is required.' };
  if (!isValidTimeZone(input.timezone)) return { ok: false, error: 'Invalid time zone.' };

  const windows = normalizeWindows(input.sendingWindows);
  if (windows.length === 0) {
    return { ok: false, error: 'At least one valid sending window is required (end must be after start).' };
  }
  const sendDays = normalizeSendDays(input.sendDays);
  if (sendDays.length === 0) return { ok: false, error: 'At least one sending day is required.' };
  if (input.steps.length === 0) return { ok: false, error: 'A campaign needs at least one step.' };

  return getDb().transaction(async (tx) => {
    const templateIds = [...new Set(input.steps.map((s) => s.templateId))];
    const found = await tx
      .select({ id: templates.id })
      .from(templates)
      .where(and(eq(templates.userId, input.userId), inArray(templates.id, templateIds)));

    if (found.length !== templateIds.length) {
      return { ok: false as const, error: 'One or more templates could not be found.' };
    }

    const inserted = await tx
      .insert(campaigns)
      .values({
        userId: input.userId,
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        serviceId: input.serviceId ?? null,
        status: 'DRAFT',
        timezone: input.timezone,
        sendingWindows: input.sendingWindows,
        sendDays,
        dailyLimit: input.dailyLimit ?? null,
        hourlyLimit: input.hourlyLimit ?? null,
        targetCriteria: input.targetCriteria ?? {},
      })
      .returning();

    const campaign = inserted[0];
    if (!campaign) return { ok: false as const, error: 'Could not create the campaign.' };

    await tx.insert(campaignSteps).values(
      input.steps.map((step, index) => ({
        campaignId: campaign.id,
        position: index,
        delayDays: Math.max(0, step.delayDays),
        delayHours: Math.max(0, step.delayHours ?? 0),
        templateId: step.templateId,
        enabled: step.enabled !== false,
      })),
    );

    await recordAudit(
      {
        userId: input.userId,
        action: 'CAMPAIGN_CREATED',
        entityType: 'campaign',
        entityId: campaign.id,
        metadata: { name: campaign.name, steps: input.steps.length },
      },
      tx,
    );

    return { ok: true as const, campaign };
  });
}

/**
 * Change campaign status through its own state machine. Pausing additionally
 * stops nothing — enrolments stay ACTIVE so a resume continues where it left
 * off — but the preflight refuses to send while the campaign is not RUNNING.
 */
export async function setCampaignStatus(
  userId: string,
  campaignId: string,
  to: CampaignStatus,
): Promise<{ ok: boolean; error?: string }> {
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
      .limit(1);

    const campaign = rows[0];
    if (!campaign) return { ok: false, error: 'Campaign not found.' };

    const from = campaign.status as CampaignStatus;
    if (from === to) return { ok: false, error: `Campaign is already ${to}.` };
    if (!ALLOWED_CAMPAIGN_TRANSITIONS[from].includes(to)) {
      return { ok: false, error: `Cannot move a ${from} campaign to ${to}.` };
    }

    if (to === 'RUNNING') {
      const steps = await tx
        .select({ id: campaignSteps.id })
        .from(campaignSteps)
        .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.enabled, true)));
      if (steps.length === 0) {
        return { ok: false, error: 'Cannot start a campaign with no enabled steps.' };
      }

      const config = await getConfig(userId);
      if (!config.postalAddress.trim()) {
        return {
          ok: false,
          error:
            'A physical postal address must be configured in Settings before a campaign can run. CAN-SPAM requires one in every commercial message.',
        };
      }
    }

    await tx
      .update(campaigns)
      .set({
        status: to,
        updatedAt: new Date(),
        ...(to === 'RUNNING' ? { startedAt: campaign.startedAt ?? new Date(), pausedAt: null } : {}),
        ...(to === 'PAUSED' ? { pausedAt: new Date() } : {}),
      })
      .where(eq(campaigns.id, campaignId));

    const action =
      to === 'RUNNING'
        ? campaign.startedAt
          ? ('CAMPAIGN_RESUMED' as const)
          : ('CAMPAIGN_STARTED' as const)
        : to === 'PAUSED'
          ? ('CAMPAIGN_PAUSED' as const)
          : to === 'ARCHIVED'
            ? ('CAMPAIGN_ARCHIVED' as const)
            : ('CAMPAIGN_CREATED' as const);

    await recordAudit(
      { userId, action, entityType: 'campaign', entityId: campaignId, metadata: { from, to } },
      tx,
    );

    logger.info('Campaign status changed', {
      event: 'campaign_status_changed',
      userId,
      campaignId,
      status: to,
    });

    return { ok: true };
  });
}

export interface EnrollResult {
  enrolled: string[];
  skipped: { prospectId: string; reason: string }[];
}

/**
 * Enrol prospects. Every reason a prospect must not be contacted is checked
 * here as well as at send time — enrolling a suppressed contact would create a
 * job that can only ever be blocked.
 */
export async function enrollProspects(
  userId: string,
  campaignId: string,
  prospectIds: string[],
): Promise<EnrollResult> {
  const result: EnrollResult = { enrolled: [], skipped: [] };

  await getDb().transaction(async (tx) => {
    const campaignRows = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
      .limit(1);

    const campaign = campaignRows[0];
    if (!campaign) {
      for (const id of prospectIds) result.skipped.push({ prospectId: id, reason: 'Campaign not found.' });
      return;
    }
    if (campaign.status === 'ARCHIVED' || campaign.status === 'COMPLETED') {
      for (const id of prospectIds) {
        result.skipped.push({ prospectId: id, reason: `Campaign is ${campaign.status}.` });
      }
      return;
    }

    for (const prospectId of prospectIds) {
      const rows = await tx
        .select({ prospect: prospects, contact: contacts })
        .from(prospects)
        .innerJoin(contacts, eq(contacts.id, prospects.contactId))
        .where(and(eq(prospects.id, prospectId), eq(prospects.userId, userId)))
        .limit(1);

      const row = rows[0];
      if (!row) {
        result.skipped.push({ prospectId, reason: 'Prospect not found.' });
        continue;
      }

      if (!isContactable(row.prospect.status as ProspectStatus)) {
        result.skipped.push({
          prospectId,
          reason: `Status ${row.prospect.status} does not permit outreach.`,
        });
        continue;
      }

      const suppression = await checkSuppression(userId, row.contact.email, tx);
      if (suppression.emailSuppressed || suppression.domainSuppressed) {
        result.skipped.push({ prospectId, reason: suppression.detail ?? 'Contact is suppressed.' });
        continue;
      }

      const active = await tx
        .select({ id: campaignMembers.id, campaignId: campaignMembers.campaignId })
        .from(campaignMembers)
        .where(and(eq(campaignMembers.prospectId, prospectId), eq(campaignMembers.status, 'ACTIVE')))
        .limit(1);

      if (active[0]) {
        result.skipped.push({
          prospectId,
          reason:
            active[0].campaignId === campaignId
              ? 'Already enrolled in this campaign.'
              : 'Already active in another campaign.',
        });
        continue;
      }

      const inserted = await tx
        .insert(campaignMembers)
        .values({ campaignId, prospectId, status: 'ACTIVE', currentPosition: 0 })
        .onConflictDoNothing()
        .returning({ id: campaignMembers.id });

      if (!inserted[0]) {
        result.skipped.push({ prospectId, reason: 'Already enrolled in this campaign.' });
        continue;
      }

      result.enrolled.push(prospectId);

      await recordActivity(
        {
          userId,
          prospectId,
          type: 'SEQUENCE_STARTED',
          title: `Enrolled in campaign: ${campaign.name}`,
          metadata: { campaignId },
        },
        tx,
      );

      await recordAudit(
        {
          userId,
          action: 'SEQUENCE_STARTED',
          entityType: 'campaign_member',
          entityId: inserted[0].id,
          metadata: { campaignId, prospectId },
        },
        tx,
      );
    }
  });

  return result;
}

/**
 * Stop a prospect's active sequence. Idempotent — stopping an already-stopped
 * enrolment is success, which matters because several triggers (reply, bounce,
 * suppression, manual) can race.
 */
export async function stopSequence(
  userId: string,
  prospectId: string,
  reason: StopReason,
  note?: string,
  existingTx?: Database,
): Promise<{ stopped: boolean }> {
  const run = async (tx: Database) => {
    const rows = await tx
      .select({ member: campaignMembers })
      .from(campaignMembers)
      .innerJoin(prospects, eq(prospects.id, campaignMembers.prospectId))
      .where(
        and(
          eq(campaignMembers.prospectId, prospectId),
          eq(campaignMembers.status, 'ACTIVE'),
          eq(prospects.userId, userId),
        ),
      )
      .limit(1);

    const member = rows[0]?.member;
    if (!member) return { stopped: false };

    await tx
      .update(campaignMembers)
      .set({ status: 'STOPPED', stoppedAt: new Date(), stopReason: reason, updatedAt: new Date() })
      .where(eq(campaignMembers.id, member.id));

    // Cancel any queued-but-unsent message for this enrolment so it cannot sit
    // in the queue being repeatedly blocked.
    await tx
      .update(messages)
      .set({ status: 'CANCELLED', blockedReason: `Sequence stopped: ${reason}`, updatedAt: new Date() })
      .where(
        and(
          eq(messages.campaignMemberId, member.id),
          sql`${messages.status} in ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED','QUEUED')`,
        ),
      );

    await recordActivity(
      {
        userId,
        prospectId,
        type: 'SEQUENCE_STOPPED',
        title: `Sequence stopped: ${reason}`,
        body: note ?? null,
        metadata: { campaignId: member.campaignId, reason },
      },
      tx,
    );

    await recordAudit(
      {
        userId,
        actorType: 'SYSTEM',
        action: 'SEQUENCE_STOPPED',
        entityType: 'campaign_member',
        entityId: member.id,
        metadata: { reason, note: note ?? null, prospectId },
      },
      tx,
    );

    logger.info('Sequence stopped', {
      event: 'sequence_stopped',
      userId,
      prospectId,
      campaignId: member.campaignId,
      status: reason,
    });

    return { stopped: true };
  };

  return existingTx ? run(existingTx) : getDb().transaction(run);
}

/** Pause every running campaign — the global emergency control (brief §56). */
export async function pauseAllCampaigns(userId: string, reason: string): Promise<number> {
  const paused = await getDb()
    .update(campaigns)
    .set({ status: 'PAUSED', pausedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(campaigns.userId, userId), eq(campaigns.status, 'RUNNING')))
    .returning({ id: campaigns.id });

  await recordAudit({
    userId,
    action: 'CAMPAIGN_PAUSED',
    entityType: 'campaign',
    entityId: null,
    metadata: { bulk: true, count: paused.length, reason },
  });

  return paused.length;
}

export async function getCampaign(userId: string, campaignId: string) {
  const rows = await getDb()
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  const campaign = rows[0];
  if (!campaign) return null;

  const steps = await getDb()
    .select({ step: campaignSteps, template: templates })
    .from(campaignSteps)
    .innerJoin(templates, eq(templates.id, campaignSteps.templateId))
    .where(eq(campaignSteps.campaignId, campaignId))
    .orderBy(asc(campaignSteps.position));

  return { campaign, steps };
}

export async function listCampaigns(userId: string) {
  return getDb()
    .select({
      campaign: campaigns,
      memberCount: sql<number>`(
        select count(*)::int from ${campaignMembers} where ${campaignMembers.campaignId} = ${campaigns.id}
      )`,
      activeCount: sql<number>`(
        select count(*)::int from ${campaignMembers}
         where ${campaignMembers.campaignId} = ${campaigns.id} and ${campaignMembers.status} = 'ACTIVE'
      )`,
      sentCount: sql<number>`(
        select count(*)::int from ${messages}
          join ${campaignMembers} cm on cm.id = ${messages.campaignMemberId}
         where cm.campaign_id = ${campaigns.id} and ${messages.status} in ('SENT','DELIVERED')
      )`,
    })
    .from(campaigns)
    .where(eq(campaigns.userId, userId))
    .orderBy(desc(campaigns.createdAt));
}

export async function listCampaignMembers(userId: string, campaignId: string, limit = 100) {
  return getDb()
    .select({ member: campaignMembers, prospect: prospects, company: companies, contact: contacts })
    .from(campaignMembers)
    .innerJoin(prospects, eq(prospects.id, campaignMembers.prospectId))
    .innerJoin(companies, eq(companies.id, prospects.companyId))
    .innerJoin(contacts, eq(contacts.id, prospects.contactId))
    .where(and(eq(campaignMembers.campaignId, campaignId), eq(prospects.userId, userId)))
    .orderBy(desc(campaignMembers.enrolledAt))
    .limit(Math.min(limit, 500));
}

/**
 * When the next step of a sequence is due, adjusted forward to the next valid
 * sending window. Returns null when the campaign can never send.
 */
export function computeStepDueAt(
  from: Date,
  step: Pick<CampaignStep, 'delayDays' | 'delayHours'>,
  campaign: Pick<Campaign, 'timezone' | 'sendingWindows' | 'sendDays'>,
  contactTimeZone?: string | null,
): Date | null {
  const target = new Date(
    from.getTime() + step.delayDays * 24 * 60 * 60 * 1000 + step.delayHours * 60 * 60 * 1000,
  );

  const timeZone =
    contactTimeZone && isValidTimeZone(contactTimeZone) ? contactTimeZone : campaign.timezone;

  return nextWindowStart(target, {
    windows: campaign.sendingWindows,
    sendDays: campaign.sendDays,
    timeZone,
  });
}
