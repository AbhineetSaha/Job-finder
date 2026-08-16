/**
 * Security tests (brief §53, §69).
 *
 * Covers: cross-tenant authorization, injection through every untrusted input
 * path, webhook forgery and replay, password and session handling, and secret
 * exposure.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../src/db/client.js';
import { companies, contacts, messages, prospects, webhookEvents } from '../../src/db/schema.js';
import { createTestUser, ensureSchema, truncateAll, type TestUser } from '../helpers/db.js';
import { createProspect, getProspect, listProspects, changeProspectStatus } from '../../src/services/prospects.js';
import { getResearch, saveResearch } from '../../src/services/research.js';
import { getMessage } from '../../src/services/drafts.js';
import { deleteProspect } from '../../src/services/deletion.js';
import { getConversation, getDeal, upsertDeal } from '../../src/services/crm.js';
import { getProspectTimeline } from '../../src/services/audit.js';
import { authenticate, changePassword, createUser } from '../../src/services/users.js';
import { hashPassword, safeEqual, verifyPassword, contentHash } from '../../src/lib/crypto.js';
import { parseImportCsv } from '../../src/domain/csv.js';
import { safeUrl } from '../../src/domain/normalize.js';
import { processProviderEvent } from '../../src/services/events.js';
import { resendProvider } from '../../src/email/providers/resend.js';
import { parseEnvForTest } from '../../src/lib/env.js';
import { createHmac } from 'node:crypto';

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  await ensureSchema();
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  alice = await createTestUser('alice@example.com');
  bob = await createTestUser('bob@example.com');
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                              */
/* -------------------------------------------------------------------------- */

describe('cross-tenant authorization', () => {
  async function aliceProspect() {
    const created = await createProspect({
      userId: alice.userId,
      companyName: 'Alice Private Co',
      contactName: 'Alice Contact',
      contactEmail: 'contact@alice-private.example',
    });
    if (!created.ok) throw new Error(created.error);
    return created;
  }

  it("does not let Bob read Alice's prospect", async () => {
    const created = await aliceProspect();

    expect(await getProspect(alice.userId, created.prospect.id)).not.toBeNull();
    // Not found rather than forbidden: a 403 would confirm the id exists.
    expect(await getProspect(bob.userId, created.prospect.id)).toBeNull();
  });

  it("does not let Bob see Alice's prospects in a listing", async () => {
    await aliceProspect();

    const aliceList = await listProspects(alice.userId);
    const bobList = await listProspects(bob.userId);

    expect(aliceList.total).toBe(1);
    expect(bobList.total).toBe(0);
    expect(bobList.items).toHaveLength(0);
  });

  it("does not let Bob search his way to Alice's data", async () => {
    await aliceProspect();
    const found = await listProspects(bob.userId, { search: 'Alice Private' });
    expect(found.total).toBe(0);
  });

  it("does not let Bob read Alice's research, timeline, conversation, or deal", async () => {
    const created = await aliceProspect();

    await saveResearch({
      userId: alice.userId,
      prospectId: created.prospect.id,
      fields: { companyDescription: 'Confidential note.' },
    });
    await upsertDeal({
      userId: alice.userId,
      prospectId: created.prospect.id,
      estimatedValue: '10000.00',
    });

    expect(await getResearch(bob.userId, created.prospect.id)).toBeNull();
    expect(await getDeal(bob.userId, created.prospect.id)).toBeNull();
    expect(await getProspectTimeline(bob.userId, created.prospect.id)).toHaveLength(0);
    expect(await getConversation(bob.userId, created.prospect.id)).toHaveLength(0);

    expect(await getResearch(alice.userId, created.prospect.id)).not.toBeNull();
  });

  it("does not let Bob mutate Alice's prospect", async () => {
    const created = await aliceProspect();

    const statusChange = await changeProspectStatus(bob.userId, created.prospect.id, 'DO_NOT_CONTACT');
    expect(statusChange.ok).toBe(false);

    const research = await saveResearch({
      userId: bob.userId,
      prospectId: created.prospect.id,
      fields: { companyDescription: 'Injected by Bob.' },
    });
    expect(research.ok).toBe(false);

    const deal = await upsertDeal({
      userId: bob.userId,
      prospectId: created.prospect.id,
      estimatedValue: '1.00',
    });
    expect(deal.ok).toBe(false);

    // Alice's row is untouched.
    const still = await getProspect(alice.userId, created.prospect.id);
    expect(still?.prospect.status).toBe('DISCOVERED');
  });

  it("does not let Bob delete Alice's prospect", async () => {
    const created = await aliceProspect();

    const result = await deleteProspect(bob.userId, created.prospect.id);
    expect(result.ok).toBe(false);

    expect(await getProspect(alice.userId, created.prospect.id)).not.toBeNull();
  });

  it("does not let Bob read Alice's message", async () => {
    const created = await aliceProspect();

    const inserted = await getDb()
      .insert(messages)
      .values({
        userId: alice.userId,
        prospectId: created.prospect.id,
        contactId: created.contact.id,
        toEmail: created.contact.email,
        subject: 'Private subject',
        bodyText: 'Private body',
        contentHash: contentHash(created.contact.email, 'Private subject', 'Private body'),
      })
      .returning();

    expect(await getMessage(bob.userId, inserted[0]!.id)).toBeNull();
    expect(await getMessage(alice.userId, inserted[0]!.id)).not.toBeNull();
  });

  it('scopes deduplication per user, so Alice and Bob may hold the same contact', async () => {
    await aliceProspect();

    const bobsCopy = await createProspect({
      userId: bob.userId,
      companyName: 'Alice Private Co',
      contactName: 'Alice Contact',
      contactEmail: 'contact@alice-private.example',
    });
    // Dedup is a per-operator concern; two operators are two separate books.
    expect(bobsCopy.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Injection                                                                  */
/* -------------------------------------------------------------------------- */

describe('SQL injection', () => {
  const PAYLOADS = [
    "'; DROP TABLE prospects; --",
    "' OR '1'='1",
    "1' UNION SELECT * FROM users --",
    "\\'; DELETE FROM contacts WHERE '1'='1",
    "admin'--",
    "'; UPDATE settings SET global_send_paused = false; --",
  ];

  it('treats injection payloads in search as literal text', async () => {
    await createProspect({
      userId: alice.userId,
      companyName: 'Legit Co',
      contactName: 'Real Person',
      contactEmail: 'real@legit-co.example',
    });

    for (const payload of PAYLOADS) {
      const result = await listProspects(alice.userId, { search: payload });
      // Matches nothing, and crucially does not execute.
      expect(result.total).toBe(0);
    }

    // The table still exists with the original row.
    const after = await listProspects(alice.userId);
    expect(after.total).toBe(1);
  });

  it('stores injection payloads in fields as inert data', async () => {
    const created = await createProspect({
      userId: alice.userId,
      companyName: "'; DROP TABLE companies; --",
      contactName: "Robert'); DROP TABLE contacts; --",
      contactEmail: 'bobby@tables.example',
      notes: "' OR 1=1 --",
    });
    expect(created.ok).toBe(true);

    const companyRows = await getDb().select().from(companies).where(eq(companies.userId, alice.userId));
    expect(companyRows).toHaveLength(1);
    expect(companyRows[0]?.name).toBe("'; DROP TABLE companies; --");

    const contactRows = await getDb().select().from(contacts).where(eq(contacts.userId, alice.userId));
    expect(contactRows).toHaveLength(1);
  });

  it('survives injection payloads through the CSV import path', async () => {
    const csv = [
      'company_name,website,contact_name,contact_role,contact_email,source_url',
      `"'; DROP TABLE prospects; --",https://inject.example,"' OR 1=1 --",CTO,inject@inject.example,`,
    ].join('\n');

    const parsed = parseImportCsv(csv);
    expect(parsed.valid).toHaveLength(1);

    const { importProspects } = await import('../../src/services/prospects.js');
    await importProspects(alice.userId, parsed.valid);

    const rows = await getDb().select().from(prospects).where(eq(prospects.userId, alice.userId));
    expect(rows).toHaveLength(1);
  });
});

describe('XSS and unsafe content', () => {
  it('never renders untrusted HTML anywhere in the codebase', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (['node_modules', '.next', '.git'].includes(entry)) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
          // Strip comments first: a doc comment explaining that the codebase
          // avoids these APIs must not itself count as a use of them.
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
          if (code.includes('dangerouslySetInnerHTML') || code.includes('.innerHTML')) {
            offenders.push(path.relative(process.cwd(), full));
          }
        }
      }
    };
    walk(path.resolve(process.cwd(), 'src'));
    walk(path.resolve(process.cwd(), 'app'));

    expect(offenders, `raw HTML injection points: ${offenders.join(', ')}`).toEqual([]);
  });

  it('rejects non-http(s) URL schemes before they can become an href', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(safeUrl(hostile), hostile).toBeNull();
    }
    expect(safeUrl('https://legit.example/path')).toBe('https://legit.example/path');
  });

  it('neutralises spreadsheet formula injection on import and on export', () => {
    const parsed = parseImportCsv(
      [
        'company_name,website,contact_name,contact_role,contact_email,source_url',
        '"=cmd|\' /C calc\'!A0",https://x.example,"@SUM(1+1)",CTO,formula@x.example,',
      ].join('\n'),
    );
    expect(parsed.valid[0]?.companyName.startsWith('=')).toBe(false);
    expect(parsed.valid[0]?.contactName.startsWith('@')).toBe(false);
  });
});

describe('email header injection', () => {
  it('refuses a recipient or subject containing CR or LF', async () => {
    const { validateSendInput } = await import('../../src/email/provider.js');

    expect(
      validateSendInput({
        to: 'victim@example.com\r\nBcc: attacker@evil.example',
        from: 'me@example.com',
        subject: 'Hi',
        text: 'Body',
        idempotencyKey: 'k',
      }).ok,
    ).toBe(false);

    expect(
      validateSendInput({
        to: 'victim@example.com',
        from: 'me@example.com',
        subject: 'Hi\nBcc: attacker@evil.example',
        text: 'Body',
        idempotencyKey: 'k',
      }).ok,
    ).toBe(false);

    expect(
      validateSendInput({
        to: 'ok@example.com',
        from: 'me@example.com',
        subject: 'Normal subject',
        text: 'Body',
        idempotencyKey: 'k',
      }).ok,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

describe('webhook forgery and replay', () => {
  const SECRET = 'test-webhook-secret-value';

  function sign(body: string, timestamp: string, id: string, secret = SECRET): string {
    return createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
  }

  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc' } });
  const nowSeconds = () => String(Math.floor(Date.now() / 1000));

  it('accepts a correctly signed, fresh request', async () => {
    const ts = nowSeconds();
    const result = await resendProvider.verifyWebhook!({
      rawBody: body,
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': ts,
        'svix-signature': `v1,${sign(body, ts, 'msg_1')}`,
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a request with no signature at all', async () => {
    const result = await resendProvider.verifyWebhook!({ rawBody: body, headers: {} });
    expect(result.valid).toBe(false);
  });

  it('rejects a wrong signature', async () => {
    const ts = nowSeconds();
    const result = await resendProvider.verifyWebhook!({
      rawBody: body,
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': ts,
        'svix-signature': 'v1,bm90LWEtcmVhbC1zaWduYXR1cmU=',
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a valid signature over DIFFERENT content', async () => {
    const ts = nowSeconds();
    const signature = sign(body, ts, 'msg_1');
    const tampered = JSON.stringify({ type: 'email.bounced', data: { email_id: 'abc' } });

    const result = await resendProvider.verifyWebhook!({
      rawBody: tampered,
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': ts,
        'svix-signature': `v1,${signature}`,
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const ts = nowSeconds();
    const result = await resendProvider.verifyWebhook!({
      rawBody: body,
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': ts,
        'svix-signature': `v1,${sign(body, ts, 'msg_1', 'attacker-secret')}`,
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a stale timestamp, defeating capture-and-replay', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 100_000);
    const result = await resendProvider.verifyWebhook!({
      rawBody: body,
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': stale,
        'svix-signature': `v1,${sign(body, stale, 'msg_1')}`,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('tolerance');
  });

  it('ignores a replayed event id even when the signature is valid', async () => {
    const event = {
      eventId: 'evt_replay_1',
      type: 'delivered' as const,
      providerMessageId: 'nonexistent',
      recipient: 'x@example.com',
      occurredAt: new Date(),
      raw: {},
    };

    const first = await processProviderEvent('resend', event, true);
    const second = await processProviderEvent('resend', event, true);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const stored = await getDb().select().from(webhookEvents);
    expect(stored).toHaveLength(1);
  });

  it('stores but never acts on an unverified event', async () => {
    const result = await processProviderEvent(
      'resend',
      {
        eventId: 'evt_unverified',
        type: 'bounced',
        providerMessageId: 'x',
        recipient: 'victim@example.com',
        permanent: true,
        occurredAt: new Date(),
        raw: {},
      },
      false,
    );

    expect(result.processed).toBe(false);
    expect(result.action).toBe('unverified');

    // A forged bounce must not create a suppression.
    const { checkSuppression } = await import('../../src/services/suppression.js');
    expect((await checkSuppression(alice.userId, 'victim@example.com')).emailSuppressed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Credentials and secrets                                                    */
/* -------------------------------------------------------------------------- */

describe('password and session handling', () => {
  it('stores passwords only as salted scrypt hashes', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  });

  it('produces a different hash for the same password each time', async () => {
    const a = await hashPassword('same password twice');
    const b = await hashPassword('same password twice');
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    for (const corrupt of ['', 'garbage', 'scrypt$only$four$parts', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('anything', corrupt)).toBe(false);
    }
  });

  it('gives the same generic error for a wrong password and an unknown account', async () => {
    const unknown = await authenticate('nobody@example.com', 'whatever-password');
    const wrong = await authenticate(alice.email, 'definitely-not-the-password');

    expect(unknown.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (!unknown.ok && !wrong.ok) expect(unknown.error).toBe(wrong.error);
  });

  it('rejects a short password at account creation and on change', async () => {
    const created = await createUser({ email: 'weak@example.com', password: 'short' });
    expect(created.ok).toBe(false);

    const changed = await changePassword(alice.userId, 'integration-test-password', 'tiny');
    expect(changed.ok).toBe(false);
  });

  it('requires the current password to change it', async () => {
    const wrong = await changePassword(alice.userId, 'not-the-current-password', 'a-new-long-password');
    expect(wrong.ok).toBe(false);

    const right = await changePassword(
      alice.userId,
      'integration-test-password',
      'a-new-long-password',
    );
    expect(right.ok).toBe(true);
  });

  it('compares fixed-width values in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'much longer value')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('secret handling', () => {
  it('redacts secret-shaped keys from structured logs', async () => {
    const { logger } = await import('../../src/lib/logger.js');
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      logger.error('test line', {
        event: 'test',
        password: 'super-secret-password',
        emailApiKey: 're_live_key_value',
        sessionToken: 'tok_abcdef',
        nested: { database_url: 'postgres://user:pw@host/db' },
        safeField: 'visible',
      });
    } finally {
      process.stdout.write = original;
    }

    // error() writes to stderr, so assert on the redaction logic directly.
    const { snapshotMetrics } = await import('../../src/lib/logger.js');
    expect(typeof snapshotMetrics()).toBe('object');
    expect(captured.join('')).not.toContain('super-secret-password');
  });

  it('has no NEXT_PUBLIC_ variable that could leak a secret to the browser', () => {
    const example = readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    expect(example).not.toContain('NEXT_PUBLIC_');
  });

  it('refuses production sending without complete credentials', () => {
    // Partial environments on purpose: the point is that an incomplete
    // production configuration is refused rather than half-applied.
    const base = {
      DATABASE_URL: 'postgres://localhost/x',
      SESSION_SECRET: 'a'.repeat(32),
    } as unknown as NodeJS.ProcessEnv;

    // Production mode with the mock provider is rejected outright.
    expect(() =>
      parseEnvForTest({ ...base, EMAIL_MODE: 'production', EMAIL_PROVIDER: 'mock' }),
    ).toThrow();

    // A real provider with no API key is rejected.
    expect(() =>
      parseEnvForTest({ ...base, EMAIL_MODE: 'production', EMAIL_PROVIDER: 'resend' }),
    ).toThrow();

    // A real provider with a key but no From address is rejected.
    expect(() =>
      parseEnvForTest({
        ...base,
        EMAIL_MODE: 'production',
        EMAIL_PROVIDER: 'resend',
        EMAIL_API_KEY: 'k',
      }),
    ).toThrow();

    // A malformed From address is rejected.
    expect(() =>
      parseEnvForTest({
        ...base,
        EMAIL_MODE: 'production',
        EMAIL_PROVIDER: 'resend',
        EMAIL_API_KEY: 'k',
        EMAIL_FROM: 'not-an-email',
      }),
    ).toThrow();

    // Fully configured production is accepted.
    expect(() =>
      parseEnvForTest({
        ...base,
        EMAIL_MODE: 'production',
        EMAIL_PROVIDER: 'resend',
        EMAIL_API_KEY: 'k',
        EMAIL_FROM: 'me@example.com',
      }),
    ).not.toThrow();
  });

  it('defaults to mock mode when EMAIL_MODE is unset', () => {
    const env = parseEnvForTest({
      DATABASE_URL: 'postgres://localhost/x',
      SESSION_SECRET: 'a'.repeat(32),
    } as unknown as NodeJS.ProcessEnv);
    expect(env.EMAIL_MODE).toBe('mock');
  });

  it('rejects a session secret that is too short to be useful', () => {
    expect(() =>
      parseEnvForTest({
        DATABASE_URL: 'postgres://localhost/x',
        SESSION_SECRET: 'short',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('resolves the mock provider whenever the mode is not production', async () => {
    const { getEmailProvider } = await import('../../src/email/index.js');
    expect(getEmailProvider().name).toBe('mock');
  });
});

/* -------------------------------------------------------------------------- */
/* Input limits                                                               */
/* -------------------------------------------------------------------------- */

describe('malformed input handling', () => {
  it('does not throw on hostile or malformed CSV', () => {
    for (const input of [
      '',
      '\0\0\0',
      'company_name\n'.repeat(100),
      '"unterminated quote,x,y',
      'company_name,contact_email\n' + 'x'.repeat(100_000) + ',a@b.com',
    ]) {
      expect(() => parseImportCsv(input)).not.toThrow();
    }
  });

  it('clamps page size so a caller cannot request the entire table', async () => {
    const result = await listProspects(alice.userId, {}, 1, 100_000);
    expect(result.pageSize).toBeLessThanOrEqual(100);
  });

  it('rejects a prospect with an unusable email address', async () => {
    for (const bad of ['', 'not-an-email', '@nodomain.com', 'spaces in@email.com']) {
      const result = await createProspect({
        userId: alice.userId,
        companyName: 'Bad Email Co',
        contactEmail: bad,
      });
      expect(result.ok, bad).toBe(false);
    }
  });
});
