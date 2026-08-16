/**
 * Integration-test database helpers.
 *
 * Uses a real PostgreSQL database (DATABASE_URL from .env.test) because the
 * guarantees under test — partial unique indexes, SKIP LOCKED claiming,
 * transactional rollback — are database behaviour, and a fake would prove
 * nothing about them.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUser } from '../../src/services/users.js';
import { resetMockProvider } from '../../src/email/providers/mock.js';
import { resetMetrics } from '../../src/lib/logger.js';
import { eq } from 'drizzle-orm';
import { settings, userProfiles } from '../../src/db/schema.js';

let migrated = false;

export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await runMigrations();
  migrated = true;
}

/** Wipe all data between tests while keeping the schema. */
export async function truncateAll(): Promise<void> {
  const db = getDb();
  const rows = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables
     where schemaname = 'public' and tablename <> '__drizzle_migrations'
  `);

  const tables = (rows.rows ?? []).map((r) => `"${r.tablename}"`);
  if (tables.length === 0) return;

  await db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`));
  resetMockProvider();
  resetMetrics();
}

export interface TestUser {
  userId: string;
  email: string;
}

/**
 * Create a fully configured user: a complete profile and a postal address.
 *
 * Both matter. The default templates reference {{sender_name}} and
 * {{sender_title}}, and the send preflight blocks without a postal address —
 * so an under-configured account cannot draft or send, which is the intended
 * behaviour and not something tests should paper over silently.
 */
export async function createTestUser(email = 'tester@example.com'): Promise<TestUser> {
  const result = await createUser({
    email,
    password: 'integration-test-password',
    name: 'Test Operator',
  });
  if (!result.ok) throw new Error(`Could not create test user: ${result.error}`);

  await getDb()
    .update(userProfiles)
    .set({ title: 'Software Engineer', email, portfolioUrl: 'https://example.com/portfolio' })
    .where(eq(userProfiles.userId, result.user.id));

  await getDb()
    .update(settings)
    .set({ postalAddress: '1 Test Street, Springfield IL 62701' })
    .where(eq(settings.userId, result.user.id));

  return { userId: result.user.id, email };
}

/** A sending window that always permits a send, for tests not about windows. */
export const ALWAYS_OPEN_WINDOW = {
  sendingWindows: [{ start: '00:00', end: '23:59' }],
  sendDays: [1, 2, 3, 4, 5, 6, 7],
};

/**
 * Enrol a prospect in a running campaign whose window is always open.
 *
 * Tests that are not about scheduling still have to go through a campaign,
 * because a message with no campaign falls back to a business-hours window —
 * so an ad-hoc draft legitimately refuses to send at 3am on a Sunday.
 */
export async function enrollInOpenCampaign(
  userId: string,
  prospectId: string,
): Promise<{ campaignId: string; memberId: string; stepId: string; templateId: string }> {
  const { campaignMembers, campaignSteps, templates } = await import('../../src/db/schema.js');
  const { createCampaign, enrollProspects, setCampaignStatus } = await import(
    '../../src/services/campaigns.js'
  );
  const { and, eq } = await import('drizzle-orm');
  const db = getDb();

  const templateRows = await db
    .select()
    .from(templates)
    .where(and(eq(templates.userId, userId), eq(templates.kind, 'INITIAL')))
    .limit(1);
  const templateId = templateRows[0]?.id;
  if (!templateId) throw new Error('No INITIAL template available.');

  const campaign = await createCampaign({
    userId,
    name: `Open campaign ${Math.random().toString(36).slice(2, 8)}`,
    timezone: 'America/New_York',
    ...ALWAYS_OPEN_WINDOW,
    steps: [{ delayDays: 0, templateId }],
  });
  if (!campaign.ok) throw new Error(campaign.error);

  await setCampaignStatus(userId, campaign.campaign.id, 'READY');
  await setCampaignStatus(userId, campaign.campaign.id, 'RUNNING');

  const enrolment = await enrollProspects(userId, campaign.campaign.id, [prospectId]);
  if (enrolment.enrolled.length === 0) {
    throw new Error(`Enrolment failed: ${enrolment.skipped[0]?.reason ?? 'unknown'}`);
  }

  const memberRows = await db
    .select()
    .from(campaignMembers)
    .where(
      and(
        eq(campaignMembers.campaignId, campaign.campaign.id),
        eq(campaignMembers.prospectId, prospectId),
      ),
    )
    .limit(1);

  const stepRows = await db
    .select()
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, campaign.campaign.id))
    .limit(1);

  return {
    campaignId: campaign.campaign.id,
    memberId: memberRows[0]!.id,
    stepId: stepRows[0]!.id,
    templateId,
  };
}
