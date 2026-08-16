/**
 * End-to-end workflow (brief §53):
 *
 *   import → deduplicate → qualify → research → personalise → human approval
 *   → queue → mock send → mock reply → sequence stops → CRM updates
 *
 * No real email can be sent: EMAIL_MODE is mock and the test bootstrap aborts
 * the run if it is anything else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../src/db/client.js';
import {
  campaignMembers,
  campaignSteps,
  messages,
  prospects,
  services,
  templates,
} from '../../src/db/schema.js';
import { createTestUser, ensureSchema, truncateAll, type TestUser } from '../helpers/db.js';
import { parseImportCsv } from '../../src/domain/csv.js';
import { createProspect, getProspect, importProspects } from '../../src/services/prospects.js';
import { qualifyProspect } from '../../src/services/qualification.js';
import { saveResearch } from '../../src/services/research.js';
import { approveDraft, createDraft, editDraft, getReviewQueue } from '../../src/services/drafts.js';
import { createCampaign, enrollProspects, setCampaignStatus } from '../../src/services/campaigns.js';
import { sendMessage } from '../../src/services/sending.js';
import { recordManualReply } from '../../src/services/events.js';
import { getConversation, getDashboardCounts } from '../../src/services/crm.js';
import { getAnalytics } from '../../src/services/analytics.js';
import { getMockSentMessages } from '../../src/email/providers/mock.js';
import { ALWAYS_OPEN_WINDOW, enrollInOpenCampaign } from '../helpers/db.js';

let user: TestUser;

beforeAll(async () => {
  await ensureSchema();
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  user = await createTestUser();
});

const PERSONALIZATION = {
  specificObservation: 'your changelog entry about rebuilding the ingestion pipeline',
  engineeringSignal: 'an open senior backend role',
  painPoint: 'keeping query latency stable as the events table grows',
  whyRelevant: 'this is the PostgreSQL work I do most weeks',
  specificOffer: 'a fixed-scope review of your slowest queries',
  relevantTechnology: 'PostgreSQL',
};

/** The operator selects which service applies to a prospect; templates reference it. */
async function getServiceId(userId: string): Promise<string> {
  const rows = await getDb()
    .select()
    .from(services)
    .where(eq(services.userId, userId))
    .limit(1);
  const service = rows[0];
  if (!service) throw new Error('No services were seeded for the user.');
  return service.id;
}

async function getInitialTemplateId(userId: string): Promise<string> {
  const rows = await getDb()
    .select()
    .from(templates)
    .where(and(eq(templates.userId, userId), eq(templates.kind, 'INITIAL')))
    .limit(1);
  const template = rows[0];
  if (!template) throw new Error('No INITIAL template was seeded for the user.');
  return template.id;
}

describe('full outreach workflow', () => {
  it('runs import → qualify → research → approve → send → reply → CRM', async () => {
    /* --- import ------------------------------------------------------- */
    const csv = [
      'company_name,website,contact_name,contact_role,contact_email,source_url',
      'Northwind Analytics,https://northwind.example,Dana Whitfield,CTO,dana@northwind.example,https://northwind.example/careers',
    ].join('\n');

    const parsed = parseImportCsv(csv);
    expect(parsed.valid).toHaveLength(1);
    expect(parsed.invalid).toHaveLength(0);

    const summary = await importProspects(user.userId, parsed.valid);
    expect(summary.created).toBe(1);

    const listed = await getDb().select().from(prospects).where(eq(prospects.userId, user.userId));
    const prospectId = listed[0]?.id as string;
    expect(prospectId).toBeTruthy();

    /* --- deduplicate --------------------------------------------------- */
    // Same person, different capitalisation and a plus tag.
    const duplicate = await createProspect({
      userId: user.userId,
      companyName: 'Northwind Analytics',
      website: 'https://northwind.example',
      contactName: 'Dana Whitfield',
      contactEmail: 'Dana+leads@Northwind.example',
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.duplicateOf?.prospectId).toBe(prospectId);

    /* --- qualify ------------------------------------------------------- */
    const qualified = await qualifyProspect(user.userId, prospectId, {
      usCompany: 'YES',
      saasOrSoftware: 'YES',
      engineeringTeamIdentified: 'YES',
      hiringEngineers: 'YES',
      contractorSignal: 'NO',
      technologyMatch: 'YES',
      engineeringNeed: 'YES',
      decisionMakerIdentified: 'YES',
    });
    expect(qualified.ok).toBe(true);
    if (qualified.ok) {
      expect(qualified.result.score).toBe(85);
      expect(qualified.result.band).toBe('STRONG');
    }

    /* --- research ------------------------------------------------------ */
    const research = await saveResearch({
      userId: user.userId,
      prospectId,
      fields: {
        companyDescription: 'Product analytics for e-commerce teams.',
        potentialPainPoint: 'Query latency on a growing events table.',
        whyRelevant: 'Their stack matches mine.',
        whyContactingThem: 'Dana is the named CTO.',
        reasonForReachingOutNow: 'They are actively hiring backend engineers.',
      },
      sources: [{ field: 'companyDescription', url: 'https://northwind.example', title: 'Site' }],
    });
    expect(research.ok).toBe(true);
    if (research.ok) expect(research.completeness.readyForReview).toBe(true);

    /* --- campaign and enrolment ---------------------------------------- */
    const templateId = await getInitialTemplateId(user.userId);

    const campaign = await createCampaign({
      userId: user.userId,
      name: 'Test campaign',
      timezone: 'America/New_York',
      ...ALWAYS_OPEN_WINDOW,
      steps: [{ delayDays: 0, templateId }],
    });
    expect(campaign.ok).toBe(true);
    if (!campaign.ok) return;

    expect((await setCampaignStatus(user.userId, campaign.campaign.id, 'READY')).ok).toBe(true);
    expect((await setCampaignStatus(user.userId, campaign.campaign.id, 'RUNNING')).ok).toBe(true);

    const enrolment = await enrollProspects(user.userId, campaign.campaign.id, [prospectId]);
    expect(enrolment.enrolled).toEqual([prospectId]);

    const members = await getDb()
      .select()
      .from(campaignMembers)
      .where(eq(campaignMembers.prospectId, prospectId));
    const memberId = members[0]?.id as string;

    const steps = await getDb()
      .select()
      .from(campaignSteps)
      .where(eq(campaignSteps.campaignId, campaign.campaign.id));
    const stepId = steps[0]?.id as string;

    /* --- draft --------------------------------------------------------- */
    const draft = await createDraft({
      userId: user.userId,
      prospectId,
      templateId,
      serviceId: await getServiceId(user.userId),
      personalization: PERSONALIZATION,
      campaignMemberId: memberId,
      campaignStepId: stepId,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const messageId = draft.message.id;
    expect(draft.message.status).toBe('PENDING_APPROVAL');
    // Manual personalisation must actually appear in the body.
    expect(draft.message.bodyText).toContain('your changelog entry about rebuilding the ingestion pipeline');
    // The compliance footer is appended by the engine, not the template.
    expect(draft.message.bodyText).toContain('1 Test Street, Springfield IL 62701');
    expect(draft.message.bodyText).toContain('Unsubscribe');

    const queue = await getReviewQueue(user.userId);
    expect(queue).toHaveLength(1);

    /* --- an unapproved message cannot send ----------------------------- */
    const premature = await sendMessage(messageId);
    expect(premature.status).toBe('BLOCKED');
    if (premature.status === 'BLOCKED') expect(premature.reason).toBe('MESSAGE_NOT_APPROVED');
    expect(getMockSentMessages()).toHaveLength(0);

    /* --- human approval ------------------------------------------------ */
    const approval = await approveDraft(user.userId, messageId, user.userId);
    expect(approval.ok).toBe(true);
    expect(approval.approvalVersion).toBe(1);

    /* --- send ----------------------------------------------------------- */
    const sent = await sendMessage(messageId);
    expect(sent.status).toBe('SENT');

    const delivered = getMockSentMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe('dana@northwind.example');

    const afterSend = await getProspect(user.userId, prospectId);
    expect(afterSend?.prospect.status).toBe('CONTACTED');
    expect(afterSend?.prospect.lastContactedAt).not.toBeNull();

    /* --- reply stops the sequence -------------------------------------- */
    const reply = await recordManualReply({
      userId: user.userId,
      prospectId,
      subject: 'Re: intro',
      bodyText: 'Interested — send availability.',
      classification: 'INTERESTED',
    });
    expect(reply.ok).toBe(true);

    const stoppedMember = await getDb()
      .select()
      .from(campaignMembers)
      .where(eq(campaignMembers.id, memberId));
    expect(stoppedMember[0]?.status).toBe('STOPPED');
    expect(stoppedMember[0]?.stopReason).toBe('REPLY_RECEIVED');

    const afterReply = await getProspect(user.userId, prospectId);
    expect(afterReply?.prospect.status).toBe('REPLIED');

    /* --- CRM and analytics --------------------------------------------- */
    const conversation = await getConversation(user.userId, prospectId);
    expect(conversation.some((e) => e.kind === 'OUTBOUND')).toBe(true);
    expect(conversation.some((e) => e.kind === 'INBOUND')).toBe(true);
    // Chronological.
    for (let i = 1; i < conversation.length; i += 1) {
      expect(conversation[i]!.at.getTime()).toBeGreaterThanOrEqual(conversation[i - 1]!.at.getTime());
    }

    const counts = await getDashboardCounts(user.userId);
    expect(counts.unreadReplies).toBeGreaterThanOrEqual(0);

    const analytics = await getAnalytics(user.userId);
    expect(analytics.prospects.total).toBe(1);
    expect(analytics.outreach.sent).toBe(1);
    expect(analytics.outreach.replies).toBe(1);
    expect(analytics.outreach.positiveReplies).toBe(1);
    expect(analytics.conversion.replyRate).toBe(100);
  });
});

describe('approval currency', () => {
  it('requires re-approval after an edit, and blocks the send until then', async () => {
    const created = await createProspect({
      userId: user.userId,
      companyName: 'Edit Test Co',
      contactName: 'Pat Editor',
      contactEmail: 'pat@edit-test.example',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const enrolment = await enrollInOpenCampaign(user.userId, created.prospect.id);
    const draft = await createDraft({
      userId: user.userId,
      prospectId: created.prospect.id,
      templateId: enrolment.templateId,
      serviceId: await getServiceId(user.userId),
      personalization: PERSONALIZATION,
      campaignMemberId: enrolment.memberId,
      campaignStepId: enrolment.stepId,
    });
    if (!draft.ok) throw new Error(draft.error);

    expect((await approveDraft(user.userId, draft.message.id, user.userId)).ok).toBe(true);

    const edit = await editDraft(user.userId, draft.message.id, {
      subject: 'A completely different subject',
    });
    expect(edit.ok).toBe(true);
    expect(edit.approvalRevoked).toBe(true);

    const after = await getDb().select().from(messages).where(eq(messages.id, draft.message.id));
    expect(after[0]?.status).toBe('PENDING_APPROVAL');

    const blocked = await sendMessage(draft.message.id);
    expect(blocked.status).toBe('BLOCKED');
    if (blocked.status === 'BLOCKED') expect(blocked.reason).toBe('MESSAGE_NOT_APPROVED');
    expect(getMockSentMessages()).toHaveLength(0);

    // Re-approving increments the version and unblocks the send.
    const reapproval = await approveDraft(user.userId, draft.message.id, user.userId);
    expect(reapproval.approvalVersion).toBe(2);
    expect((await sendMessage(draft.message.id)).status).toBe('SENT');
  });

  it('refuses an approval whose expected hash no longer matches', async () => {
    const created = await createProspect({
      userId: user.userId,
      companyName: 'Race Co',
      contactName: 'Robin Race',
      contactEmail: 'robin@race-co.example',
    });
    if (!created.ok) return;

    const templateId = await getInitialTemplateId(user.userId);
    const draft = await createDraft({
      userId: user.userId,
      prospectId: created.prospect.id,
      templateId,
      serviceId: await getServiceId(user.userId),
      personalization: PERSONALIZATION,
    });
    if (!draft.ok) throw new Error(draft.error);

    await editDraft(user.userId, draft.message.id, { subject: 'Changed after render' });

    // The reviewer approves against the content they saw, which is now stale.
    const result = await approveDraft(
      user.userId,
      draft.message.id,
      user.userId,
      draft.message.contentHash,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('changed since you opened it');
  });
});

describe('template rendering refuses to invent content', () => {
  it('fails the draft when a personalisation field is missing', async () => {
    const created = await createProspect({
      userId: user.userId,
      companyName: 'Missing Vars Co',
      contactName: 'Sam Blank',
      contactEmail: 'sam@missing-vars.example',
    });
    if (!created.ok) return;

    const templateId = await getInitialTemplateId(user.userId);

    const draft = await createDraft({
      userId: user.userId,
      prospectId: created.prospect.id,
      templateId,
      serviceId: await getServiceId(user.userId),
      // Deliberately empty: the template needs specific_observation et al.
      personalization: {},
    });

    expect(draft.ok).toBe(false);
    if (!draft.ok) {
      expect(draft.renderError?.missing).toContain('specific_observation');
      expect(draft.error).toContain('missing values for');
    }

    // Nothing was persisted.
    const drafts = await getDb().select().from(messages).where(eq(messages.userId, user.userId));
    expect(drafts).toHaveLength(0);
  });
});
