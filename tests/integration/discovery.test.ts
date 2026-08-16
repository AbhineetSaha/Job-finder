/**
 * Discovery integration tests.
 *
 * Runs the real service against a real database, with HTTP injected so no
 * network is touched. The Hacker News adapter is exercised end to end against
 * recorded Algolia-shaped fixtures.
 *
 * The property these tests exist to protect: discovery stages candidates and
 * nothing else. It creates no prospects, enrols nobody, and sends nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../src/db/client.js';
import {
  discoveredCandidates,
  discoveryRuns,
  messages,
  prospects,
  userProfiles,
} from '../../src/db/schema.js';
import { createTestUser, ensureSchema, truncateAll, type TestUser } from '../helpers/db.js';
import {
  createDiscoverySource,
  listCandidates,
  promoteCandidate,
  rejectCandidate,
  runDiscovery,
} from '../../src/services/discovery.js';
import { createProspect } from '../../src/services/prospects.js';
import { addSuppression } from '../../src/services/suppression.js';
import { PoliteHttpClient } from '../../src/sources/http.js';
import { getMockSentMessages } from '../../src/email/providers/mock.js';

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

  await getDb()
    .update(userProfiles)
    .set({
      skills: ['Java', 'Spring Boot', 'TypeScript', 'Node.js', 'React', 'PostgreSQL'],
      industries: ['SaaS'],
    })
    .where(eq(userProfiles.userId, user.userId));
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const STORY_SEARCH = {
  hits: [{ objectID: '111', title: 'Ask HN: Who is hiring? (August 2025)', created_at: '2025-08-01' }],
};

const THREAD = {
  id: 111,
  children: [
    {
      id: 1001,
      author: 'northwind',
      text:
        'Northwind Analytics | Austin, TX | Senior Backend Engineer | REMOTE<p>' +
        'Series A product analytics company. Stack: TypeScript, Node.js, PostgreSQL, React.<p>' +
        'Open to contract. Email <a href="mailto:jobs@northwind.io">jobs@northwind.io</a>',
    },
    {
      id: 1002,
      author: 'acmesoftech',
      text:
        'Acme Softech | Bengaluru, India | Java Engineer<p>' +
        'We use Java and Spring Boot. Email careers@acmesoftech.in',
    },
    {
      id: 1003,
      author: 'quietco',
      text: 'Quiet Insurance Co | Hartford, CT | Claims Adjuster<p>No engineering here.',
    },
    {
      id: 1004,
      author: 'berlinco',
      text:
        'Cobalt Systems | Berlin, Germany | Backend Engineer<p>' +
        'Seed stage. We run Java and PostgreSQL. hiring@cobaltsystems.de',
    },
    {
      id: 1005,
      author: 'noheader',
      text: 'Hello everyone, our team is looking for someone who can help us with our platform this year',
    },
  ],
};

/** An HTTP client that serves fixtures and never touches the network. */
function fixtureHttp(routes: Record<string, unknown>): PoliteHttpClient {
  return new PoliteHttpClient({
    minIntervalMs: 0,
    sleepImpl: async () => undefined,
    fetchImpl: async (url: string) => {
      const key = Object.keys(routes).find((route) => url.includes(route));
      if (!key) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify(routes[key]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

async function createHnSource(config: Record<string, unknown> = {}) {
  const result = await createDiscoverySource({
    userId: user.userId,
    kind: 'hacker-news',
    name: `HN ${Math.random().toString(36).slice(2, 8)}`,
    config: { limit: 50, minMatchScore: 0, ...config },
  });
  if (!result.ok) throw new Error(result.error);
  return result.source;
}

const HN_HTTP = () =>
  fixtureHttp({
    '/search_by_date': STORY_SEARCH,
    '/items/111': THREAD,
  });

/* -------------------------------------------------------------------------- */

describe('running a discovery source', () => {
  it('stages matching candidates and excludes Indian companies', async () => {
    const source = await createHnSource();

    const result = await runDiscovery({
      userId: user.userId,
      sourceId: source.id,
      http: HN_HTTP(),
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.error).toBeNull();
    // The Indian company was dropped by the geography policy.
    expect(result.excludedByGeography).toBe(1);

    const staged = await listCandidates(user.userId, { status: 'NEW' });
    const names = staged.items.map((c) => c.companyName);

    expect(names).toContain('Northwind Analytics');
    expect(names).toContain('Cobalt Systems');
    expect(names).not.toContain('Acme Softech');
  });

  it('captures the published email, funding, hiring, and stack', async () => {
    const source = await createHnSource();
    await runDiscovery({ userId: user.userId, sourceId: source.id, http: HN_HTTP() });

    const staged = await listCandidates(user.userId, { status: 'NEW' });
    const northwind = staged.items.find((c) => c.companyName === 'Northwind Analytics');

    expect(northwind).toBeDefined();
    expect(northwind?.publishedEmail).toBe('jobs@northwind.io');
    expect(northwind?.country).toBe('US');
    expect(northwind?.contactability).toBe('OPT_OUT_REGIME');
    expect(northwind?.fundingSignals).toContain('Series A');
    expect(northwind?.hiringSignals).toContain('Open to contract work');
    expect(northwind?.technologyStack).toContain('postgresql');
    expect(northwind?.matchScore).toBeGreaterThanOrEqual(50);
    expect(northwind?.matchReasons.join(' ')).toContain('Technology match');
  });

  it('marks a European company as consent-required rather than contactable', async () => {
    const source = await createHnSource();
    await runDiscovery({ userId: user.userId, sourceId: source.id, http: HN_HTTP() });

    const staged = await listCandidates(user.userId, { status: 'NEW' });
    const cobalt = staged.items.find((c) => c.companyName === 'Cobalt Systems');

    expect(cobalt?.country).toBe('DE');
    expect(cobalt?.contactability).toBe('CONSENT_REQUIRED');
  });

  it('creates no prospects and sends nothing', async () => {
    const source = await createHnSource();
    await runDiscovery({ userId: user.userId, sourceId: source.id, http: HN_HTTP() });

    // The whole point: discovery finds, it does not act.
    const createdProspects = await getDb()
      .select()
      .from(prospects)
      .where(eq(prospects.userId, user.userId));
    const createdMessages = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.userId, user.userId));

    expect(createdProspects).toHaveLength(0);
    expect(createdMessages).toHaveLength(0);
    expect(getMockSentMessages()).toHaveLength(0);
  });

  it('is idempotent — re-running stages nothing new', async () => {
    const source = await createHnSource();

    const first = await runDiscovery({ userId: user.userId, sourceId: source.id, http: HN_HTTP() });
    const second = await runDiscovery({ userId: user.userId, sourceId: source.id, http: HN_HTTP() });

    expect(first.candidatesCreated).toBeGreaterThan(0);
    expect(second.candidatesCreated).toBe(0);
    expect(second.duplicatesSkipped).toBeGreaterThan(0);

    const staged = await listCandidates(user.userId, { status: 'NEW' });
    expect(staged.total).toBe(first.candidatesCreated);
  });

  it('applies a minimum match score', async () => {
    const source = await createHnSource({ minMatchScore: 60 });
    const result = await runDiscovery({
      userId: user.userId,
      sourceId: source.id,
      http: HN_HTTP(),
    });

    expect(result.belowMatchThreshold).toBeGreaterThan(0);
    const staged = await listCandidates(user.userId, { status: 'NEW' });
    expect(staged.items.every((c) => c.matchScore >= 60)).toBe(true);
  });

  it('skips a company that is already a prospect', async () => {
    await createProspect({
      userId: user.userId,
      companyName: 'Northwind Analytics',
      contactName: 'Dana Whitfield',
      contactEmail: 'dana@northwind.io',
    });

    const source = await createHnSource();
    const result = await runDiscovery({
      userId: user.userId,
      sourceId: source.id,
      http: HN_HTTP(),
    });

    expect(result.duplicatesSkipped).toBeGreaterThan(0);
    const staged = await listCandidates(user.userId, { status: 'NEW' });
    expect(staged.items.map((c) => c.companyName)).not.toContain('Northwind Analytics');
  });

  it('records a failure on the run rather than throwing', async () => {
    const source = await createHnSource();
    const brokenHttp = new PoliteHttpClient({
      minIntervalMs: 0,
      maxAttempts: 1,
      sleepImpl: async () => undefined,
      fetchImpl: async () => new Response('upstream is down', { status: 500 }),
    });

    const result = await runDiscovery({
      userId: user.userId,
      sourceId: source.id,
      http: brokenHttp,
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toBeTruthy();

    const runs = await getDb()
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.userId, user.userId));
    expect(runs[0]?.status).toBe('FAILED');
    expect(runs[0]?.error).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Promotion                                                                  */
/* -------------------------------------------------------------------------- */

describe('promoting a candidate', () => {
  async function stageCandidates() {
    const source = await createHnSource();
    await runDiscovery({ userId: user.userId, sourceId: source.id, http: HN_HTTP() });
    const staged = await listCandidates(user.userId, { status: 'NEW' });
    return staged.items;
  }

  it('creates a prospect from a US candidate with a published email', async () => {
    const candidates = await stageCandidates();
    const northwind = candidates.find((c) => c.companyName === 'Northwind Analytics')!;

    const result = await promoteCandidate({
      userId: user.userId,
      candidateId: northwind.id,
      contactName: 'Dana Whitfield',
      contactRole: 'CTO',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const created = await getDb()
      .select()
      .from(prospects)
      .where(eq(prospects.id, result.prospectId));
    expect(created).toHaveLength(1);
    // A promoted prospect starts at the beginning of the workflow, not part-way
    // through it: it still has to be researched, drafted, and approved.
    expect(created[0]?.status).toBe('DISCOVERED');

    const refreshed = await getDb()
      .select()
      .from(discoveredCandidates)
      .where(eq(discoveredCandidates.id, northwind.id));
    expect(refreshed[0]?.status).toBe('PROMOTED');
    expect(refreshed[0]?.promotedProspectId).toBe(result.prospectId);
  });

  it('refuses a consent-required candidate until the risk is acknowledged', async () => {
    const candidates = await stageCandidates();
    const cobalt = candidates.find((c) => c.companyName === 'Cobalt Systems')!;

    const blocked = await promoteCandidate({ userId: user.userId, candidateId: cobalt.id });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain('consent-based');

    const allowed = await promoteCandidate({
      userId: user.userId,
      candidateId: cobalt.id,
      acknowledgedConsentRisk: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it('refuses to promote without a contact address, and never invents one', async () => {
    const candidates = await stageCandidates();
    const quiet = candidates.find((c) => c.publishedEmail === null);

    if (quiet) {
      const result = await promoteCandidate({ userId: user.userId, candidateId: quiet.id });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('never guesses');

      // Supplying one by hand is the intended path.
      const manual = await promoteCandidate({
        userId: user.userId,
        candidateId: quiet.id,
        contactEmail: 'someone@quiet-insurance.test',
      });
      expect(manual.ok).toBe(true);
    }
  });

  it('refuses a suppressed address and rejects the candidate', async () => {
    const candidates = await stageCandidates();
    const northwind = candidates.find((c) => c.companyName === 'Northwind Analytics')!;

    await addSuppression({
      userId: user.userId,
      email: 'jobs@northwind.io',
      reason: 'UNSUBSCRIBED',
    });

    const result = await promoteCandidate({ userId: user.userId, candidateId: northwind.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('suppression list');

    // Suppression survives rediscovery: the candidate is closed out, not left
    // in the queue to be tried again next week.
    const refreshed = await getDb()
      .select()
      .from(discoveredCandidates)
      .where(eq(discoveredCandidates.id, northwind.id));
    expect(refreshed[0]?.status).toBe('REJECTED');
  });

  it('will not promote the same candidate twice', async () => {
    const candidates = await stageCandidates();
    const northwind = candidates.find((c) => c.companyName === 'Northwind Analytics')!;

    expect((await promoteCandidate({ userId: user.userId, candidateId: northwind.id })).ok).toBe(true);

    const second = await promoteCandidate({ userId: user.userId, candidateId: northwind.id });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('already been promoted');
  });

  it('records a rejection with its reason', async () => {
    const candidates = await stageCandidates();
    const first = candidates[0]!;

    expect((await rejectCandidate(user.userId, first.id, 'Too small')).ok).toBe(true);

    const refreshed = await getDb()
      .select()
      .from(discoveredCandidates)
      .where(eq(discoveredCandidates.id, first.id));
    expect(refreshed[0]?.status).toBe('REJECTED');
    expect(refreshed[0]?.reviewNote).toBe('Too small');
  });
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                              */
/* -------------------------------------------------------------------------- */

describe('discovery is scoped per operator', () => {
  it("does not let another user see or promote someone else's candidates", async () => {
    const source = await createHnSource();
    await runDiscovery({ userId: user.userId, sourceId: source.id, http: HN_HTTP() });

    const other = await createTestUser('other@example.com');

    const theirs = await listCandidates(other.userId, { status: 'NEW' });
    expect(theirs.total).toBe(0);

    const mine = await listCandidates(user.userId, { status: 'NEW' });
    const result = await promoteCandidate({
      userId: other.userId,
      candidateId: mine.items[0]!.id,
      contactEmail: 'x@y.io',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not found');
  });

  it("does not let another user run someone else's source", async () => {
    const source = await createHnSource();
    const other = await createTestUser('other2@example.com');

    await expect(
      runDiscovery({ userId: other.userId, sourceId: source.id, http: HN_HTTP() }),
    ).rejects.toThrow('not found');
  });
});
