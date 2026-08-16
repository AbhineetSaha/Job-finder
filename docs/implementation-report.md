# Implementation report

Branch `claude/freelance-client-acquisition-qv8fi6` · 6 commits · 228 tests
passing · typecheck and production build clean.

---

## 1. Summary

The repository was **empty** — a bare git repo with no commits. Everything here
is new. The stack was chosen to match the operator's own primary technologies
rather than an incumbent codebase: Next.js 15 + React 19 + TypeScript (strict),
PostgreSQL 16 + Drizzle ORM, Zod, Vitest. **Seven runtime dependencies total.**

What was built: a prospecting, research, outreach, follow-up, CRM, and
analytics system with a mandatory human approval gate, four independent
duplicate-send guards, DST-correct sending windows, a suppression list that
survives deletion, and no AI dependency of any kind.

Verified end-to-end against a running instance and a real PostgreSQL database,
not merely typechecked.

## 2. Architecture

Three processes, one database:

```
browser ──▶ web (Next.js)  ──┐
provider webhooks ───────────┼──▶  PostgreSQL  ◀── scheduler (enqueues due work)
                             └──▶               ◀── worker (claims, sends)
                                                        └──▶ EmailProvider
```

The web process never sends email. Layering is one-directional:
`app/ → services/ → repositories/db + domain/ + email/`.

**`src/domain/` is pure** — no I/O, no imports upward. Every rule that must
never be violated lives there as a function over plain data, which is why the
safety review below is a set of executable assertions rather than prose.

| Module | Responsibility |
| --- | --- |
| `domain/safety.ts` | The single send gate. No default-allow branch. |
| `domain/normalize.ts` | Deterministic identity for dedup and suppression |
| `domain/dedup.ts` | Four-key match ladder, incl. intra-batch |
| `domain/qualification.ts` | Tri-state scoring; UNKNOWN is never a guess |
| `domain/template.ts` | Missing variable is an error, never a blank |
| `domain/timezone.ts` / `window.ts` | DST-correct scheduling, no date library |
| `domain/ratelimit.ts` | Daily/hourly/per-domain, backoff with full jitter |
| `domain/status.ts` | Explicit transition state machine |
| `domain/csv.ts` | RFC 4180 + formula-injection neutralisation |

## 3. Database

28 tables. Company, contact, and prospect are separate so one company can hold
several contacts without duplicated data and deduplication stays reliable.
Full rationale in `docs/data-model.md`.

Four guarantees are enforced by the **database**, so a race cannot defeat them:

| Constraint | Guarantees |
| --- | --- |
| `contacts (user_id, normalized_email)` UNIQUE | one row per person |
| `campaign_members (prospect_id) WHERE status='ACTIVE'` UNIQUE | at most one live sequence per prospect |
| `messages (campaign_member_id, campaign_step_id)` UNIQUE | one message per sequence step, permanently |
| `message_attempts (idempotency_key)` UNIQUE | a retry cannot re-send |

Indexes were added against actual query patterns and are listed with the query
each serves in `docs/data-model.md`.

## 4. API

All mutations are POST through `formAction`, which enforces the session check
and CSRF double-submit **before the handler body runs** — a handler cannot
forget, because it never receives control until both pass.

| Route | Purpose |
| --- | --- |
| `POST /api/auth/login` · `/logout` | Session lifecycle |
| `POST /api/prospects` · `/import` | Manual create, CSV commit |
| `POST /api/prospects/[id]/status` | State-machine transition |
| `POST /api/qualify/[id]` · `/api/research/[id]` | Scoring, research |
| `POST /api/drafts/[id]` · `/edit` · `/approve` · `/reject` | Drafting and the approval gate |
| `POST /api/campaigns` · `/[id]/status` | Campaign lifecycle |
| `POST /api/replies/[id]/classify` | Human reply classification |
| `POST /api/settings/{pause,compliance,limits,profile,suppression,retry/[id]}` | Config and ops |
| `GET /api/export/{prospects,activities}` | CSV export, formula-escaped |
| `GET /api/metrics` | Counters, session-protected |
| `POST /api/webhooks/email` | HMAC-verified; the one CSRF-exempt route |
| `GET /unsubscribe/[token]` | No login, no confirmation step |

## 5. UI

Dashboard ("what needs my attention today?"), prospects list with SQL-side
filtering and pagination, prospect detail, manual entry, CSV import with
preview, review queue, campaigns, conversations, pipeline board, analytics,
settings, and the public unsubscribe page.

The **prospect detail** page is the research workstation: the ten research
questions with a source URL per answer, the eight qualification signals with a
live score preview, the draft composer, and the timeline — one page. A field
answered without a source renders as `unverified`, not as fact.

The **review queue** shows everything §20 requires before a decision and binds
the approve button to the content hash the reviewer actually saw.

A banner is always visible showing mock vs production mode, or a red banner
when sending is paused.

## 6. Email

```ts
interface EmailProvider {
  readonly name: string;
  isConfigured(): boolean;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  getMessage?(id): Promise<ProviderMessage | null>;
  verifyWebhook?(req): Promise<WebhookVerification>;
  parseWebhook?(req): ProviderEvent[];
}
```

Two adapters: `mock` (default) and `resend` (HTTP via `fetch`, no dependency).
Nothing outside `src/email/` imports a provider concretely.

**The factory returns the mock provider unless `EMAIL_MODE=production`.** That
makes "no real email during development" structural rather than a convention.

Send pipeline, in three phases so no network call is made while holding locks:

1. **Transaction** — lock the message row, re-read every input, build a
   complete `SendPreflightSnapshot`, evaluate it, claim an attempt row, mark
   the message SENDING.
2. **No transaction** — call the provider.
3. **Transaction** — record the outcome, write the send ledger, advance the
   sequence position and prospect status, log the activity and audit rows.

## 7. Campaigns

Steps are `campaign_steps` rows, not constants. The Day 0 / +4 / +9 / +16
default is seed data.

Sending windows are local wall-clock ranges plus an IANA zone. Conversion uses
the platform tz database via `Intl`, so DST is correct by construction. The
prospect's timezone wins when known.

**Follow-ups are not exempt from approval.** Every step is drafted into the
review queue and needs its own explicit approval.

## 8. Safety

**Approval.** Bound to `SHA-256(recipient + subject + body)`. Editing revokes
it. At send time the hash is *recomputed from the message as it exists then*
rather than read from the stored column — so an edit that somehow bypassed
`editDraft` still invalidates the approval.

**Duplicate sends — four independent guards**, any one sufficient:

1. `message_attempts.idempotency_key` UNIQUE, inserted *before* the provider call
2. `messages (campaign_member_id, campaign_step_id)` partial UNIQUE
3. Preflight `alreadyDispatched` / `alreadySentForStep`
4. `SELECT … FOR UPDATE` row lock plus in-flight attempt detection

**Fail-closed by construction.** `evaluateSendPreflight` has no default-allow
branch, and `assertSnapshotComplete` verifies every one of its 25 fields is
present at runtime. A value the caller could not determine cannot be quietly
omitted — an absent field blocks with `SNAPSHOT_INCOMPLETE`. This is tested by
deleting each field in turn and asserting the send is blocked.

**Global pause** is re-read inside the send transaction per job, so it stops
work already queued, not just new work.

**Suppression** is checked at draft time, approval time, enrolment time, and
again inside the send transaction. An address that cannot be normalised is
treated as suppressed.

**Rate limits** count from a narrow `send_ledger` table, so limit checks never
scan `messages`. A limit of `0` reads as "no sends", not "unlimited".

## 9. Testing

**228 tests, all passing**, against a real PostgreSQL database. No test can
send real email: the bootstrap aborts the run if `EMAIL_MODE=production`.

| Suite | Tests | Covers |
| --- | --- | --- |
| `unit/domain` | 57 | normalisation, dedup, scoring, templates, roles, status machine, rate limits |
| `unit/safety` | 42 | every guard, incomplete snapshots, and §70 as assertions |
| `unit/scheduling` | 29 | DST both directions, window arithmetic, monotonicity |
| `unit/csv` | 24 | RFC 4180, formula injection, hostile input |
| `unit/no-ai-dependency` | 8 | no AI package, import, env var, or hostname |
| `integration/workflow` | 4 | full import → … → reply → CRM path |
| `integration/safety` | 25 | suppression, stop conditions, limits, pause, idempotency, deletion |
| `security/security` | 39 | cross-tenant, injection, webhook forgery, credentials, secrets |

**Four real bugs were found by these tests and fixed**, each of which would
have caused a production failure:

1. **Concurrent sends were only prevented by provider-side idempotency.** Three
   simultaneous `sendMessage` calls all reported SENT. The in-flight-attempt
   reuse path, written for crash recovery, also let a concurrent worker
   through. A STARTED attempt is now interpreted by *age*: recent means another
   worker owns the send and this one is refused; older than the visibility
   timeout means the previous worker died, and the attempt number is reused so
   the provider sees an identical idempotency key.

2. **Raw `SELECT *` returned snake_case columns.** `message.userId` and
   `job.maxAttempts` were `undefined`, so audit writes hit a not-null
   constraint and the job retry cap never applied — jobs would have retried
   forever. Both now go through the query builder.

3. **`ON CONFLICT` could not use the partial `dedupe_key` index** (Postgres
   42P10), so every deduplicated enqueue raised an error. The predicate was
   unnecessary — NULLs are already distinct in a unique index — and is dropped
   in migration 0001.

4. **A message blocked as "not approved yet" was marked BLOCKED**, silently
   removing it from the operator's review queue. It now keeps its status and
   only records the reason.

Also verified live over HTTP against a running instance: unauthenticated
redirect, 401 on `/api/metrics`, CSRF rejection with a missing and a wrong
token (creating nothing), 401 on an unsigned webhook, security headers present,
and a graceful invalid-unsubscribe page.

## 10. Security review

Performed against the §69 checklist. Full model in `docs/security.md`.

| Area | Finding |
| --- | --- |
| Authentication | scrypt (N=16384), opaque session tokens stored only as SHA-256; per-IP and per-account login throttling; fixed-cost dummy verify so timing does not reveal account existence |
| Authorization | every query scoped by `user_id`; foreign ids return 404 not 403; 8 cross-tenant tests |
| Input validation | Zod at every boundary; numeric limits clamped, not merely checked |
| SQL injection | Drizzle parameterises everything; 6 payloads driven through search, fields, and CSV |
| XSS | zero `dangerouslySetInnerHTML` (asserted by a test that strips comments first); URLs validated to http/https before becoming an href |
| CSRF | double-submit verified before handler bodies run; webhook exempt and HMAC-authenticated instead |
| Webhook security | HMAC over raw body with `timingSafeEqual`, timestamp tolerance, unique event id; 5 forgery variants + replay tested; unverified events stored but never acted on |
| Secret handling | env module throws if imported into a browser bundle; no `NEXT_PUBLIC_*`; logs redact secret-shaped keys (verified in test output) |
| Rate limiting | login, sending (3 dimensions), enforced inside the send transaction |
| Duplicate sends | four independent guards, all tested |
| Suppression | checked on four paths; unsubscribe irreversible by design |
| Audit logs | append-only; no UPDATE or DELETE exists in application code |
| Data deletion | deletion never removes suppression — tested explicitly |
| Queue security | jobs carry ids, not payload data; the worker re-reads everything |

**No critical or high issues remain open.** Residual risks are documented in
`docs/security.md` §"Known residual risks": no 2FA, no application-level
encryption at rest, trust in provider-reported delivery events, and the
unavoidable fact that a human can still deliberately approve a bad email.

## 11. Compliance

`docs/compliance.md` maps each CAN-SPAM requirement to the control supporting
it. Notable ones:

- Postal address is **required** — the worker blocks with
  `MISSING_POSTAL_ADDRESS` and a campaign cannot start without it.
- Unsubscribe is one-click, needs no login, and is honoured **synchronously**:
  suppression, sequence stop, and status change commit in one transaction.
- Suppression **survives prospect deletion**. Without this, "clean up old
  prospects" would silently make everyone who unsubscribed contactable again.
- Unsubscribe tokens never expire and stay usable after first use.

Deliberately absent: open-tracking pixels, click trackers, domain/IP rotation,
subject obfuscation, hidden unsubscribe links.

> The documentation states plainly that the system is **not** "legally
> compliant" — it provides technical controls, and the operator remains
> responsible. Flagged for professional legal advice: applicability of state
> privacy statutes, whether any list source constitutes a "sale" of personal
> information, and any outreach to non-US recipients.

## 12. Deployment

One managed PostgreSQL instance, one web container, one worker, one scheduler.
No Redis, no broker, no object store.

```bash
npm ci && npm run build
npm run db:migrate          # idempotent
# start: npm run start · npm run worker · npm run scheduler
```

Migrations are additive by policy, so rollback is redeploying the previous
image. Destructive changes split across two releases. Backup, restore, and
database role hardening in `docs/operations.md`.

**One operational rule worth repeating:** after any point-in-time restore, keep
sending paused and reconcile the suppression list against the provider's
unsubscribe records for the gap period before resuming.

## 13. Environment variables

```
DATABASE_URL                        required
SESSION_SECRET                      required, >=32 chars
NODE_ENV                            development | test | production
APP_URL                             http://localhost:3000

EMAIL_MODE                          mock | production          (default mock)
EMAIL_PROVIDER                      mock | resend              (default mock)
EMAIL_API_KEY                       required in production
EMAIL_FROM                          required in production
EMAIL_REPLY_TO                      optional
EMAIL_WEBHOOK_SECRET                required for webhooks to accept anything
WEBHOOK_TOLERANCE_SECONDS           300

DAILY_SEND_LIMIT                    20
HOURLY_SEND_LIMIT                   5
PER_DOMAIN_SEND_LIMIT               2
MIN_SEND_DELAY_SECONDS              90
MAX_SEND_DELAY_SECONDS              600

DEFAULT_TIMEZONE                    America/New_York
FOLLOWUP_ENABLED                    true

WORKER_POLL_INTERVAL_MS             5000
WORKER_BATCH_SIZE                   5
WORKER_VISIBILITY_TIMEOUT_SECONDS   300
JOB_MAX_ATTEMPTS                    5

LOG_LEVEL                           info
```

No AI variables. No `NEXT_PUBLIC_*`. Both asserted by tests.

## 14. Known limitations

Stated plainly:

1. **Reply detection depends on the provider.** Most cold outreach from a
   personal domain replies straight to your inbox, not through a webhook. The
   primary path is therefore `recordManualReply` — you log the reply, which
   stops the sequence. Automatic reply capture needs a provider with inbound
   parsing.
2. **No inbox integration.** No IMAP/Gmail sync. Replies are logged manually or
   arrive by webhook.
3. **Delivery rate reads 0% without provider webhooks**, because nothing
   reports delivery. That is honest rather than optimistic, but it looks like a
   bug until webhooks are configured.
4. **Follow-up drafts start with empty personalisation.** The worker creates
   the draft; you fill in the specifics in the review queue. A follow-up
   template referencing an unfilled variable produces a draft that will not
   render, logged as a warning rather than silently skipped.
5. **Single operator assumed.** Every row is `user_id`-scoped and a second seat
   is a policy change, not a migration — but there is no team UI, no roles
   beyond OWNER/OPERATOR, and no sharing.
6. **No 2FA.**
7. **The pipeline board has no drag-and-drop.** Status changes are explicit
   dropdowns. Deliberate — every transition is validated and recorded — but
   less slick than a Kanban board.
8. **Login throttling is in-process.** With multiple web containers each holds
   its own counter. Move to a shared store if the web tier is scaled out.
9. **No prospect sourcing.** `ProspectSource` exists as an interface with
   `CsvSource` and `ManualSource`; finding prospects is your work.
10. **Retention is off by default.** Opt-in, because silently deleting business
    history is worse than keeping it.

## 15. Future improvements

Only the ones that would earn their keep:

1. **Provider webhooks for a real inbox** — the single biggest gap. Delivery
   rate and automatic reply capture both depend on it.
2. **TOTP two-factor** — straightforward, and this database holds your entire
   commercial pipeline.
3. **Follow-up personalisation carry-over** — reuse the initial message's
   stored variables as defaults so a follow-up drafts cleanly.
4. **A "similar prospects" view** — same industry, same stack, comparable size;
   pure SQL, no ML, and directly useful when a message lands well.
5. **Calendar integration for meeting booking** — currently manual entry.
6. **Shared login throttle** if the web tier is ever scaled beyond one instance.

Deliberately not recommended: AI anything, automatic scraping, enrichment
vendors, or automatic campaign optimisation.

## 16. First production campaign

Run this exactly. It is designed so that the first real send is deliberate.

**Before you start.** Configure SPF, DKIM, and DMARC for your sending domain,
and read your provider's cold-outreach policy — some prohibit it outright on
shared infrastructure. This is not something the software can do for you.

```bash
# 1. Set up your own account (not the seed)
npm run db:migrate
npm run outreach -- user create --email you@yourdomain.com --password '…' --name 'Your Name'
```

**2. Settings → Profile.** Fill in name, title, reply-to email, portfolio URL.
The default templates reference your name and title; leaving them blank makes
drafts refuse to render rather than send an email with a gap in it.

**3. Settings → Compliance.** Enter a real physical postal address. Sending is
blocked without it. Verify it appears in a draft's footer.

**4. Add five prospects — five, not fifty.** Manually or by CSV. Research each
one properly: fill in the ten questions, attach a source URL to every claim you
would repeat in an email.

**5. Score them.** Only send to Strong or High Priority (75+) for the first run.

**6. Create a campaign, still in mock mode:**
- Windows `09:00–11:30, 13:00–16:30`, weekdays only
- Timezone matching your prospects
- Steps: initial only. **Disable follow-ups for the first campaign.**
- Settings → Limits: daily 5, hourly 2, per-domain 1

**7. Draft, and read every one out loud.** If a sentence would embarrass you
coming from a stranger, rewrite it. If you cannot fill in
`specific_observation` with something concretely true, that prospect is not
ready — do more research or drop them.

**8. Approve in the review queue.** Check the recipient, the subject, and that
the footer has your address and an unsubscribe link.

**9. Run the worker in mock mode and confirm the whole path works:**

```bash
npm run worker      # one terminal
npm run scheduler   # another
npm run outreach -- analytics
```

Confirm five messages moved to SENT, and read what would have gone out.

**10. Only now, enable production:**

```bash
EMAIL_MODE=production
EMAIL_PROVIDER=resend
EMAIL_API_KEY=…
EMAIL_FROM=you@yourdomain.com
EMAIL_REPLY_TO=you@yourdomain.com
EMAIL_WEBHOOK_SECRET=…
```

Restart web, worker, and scheduler. Confirm the UI shows the red **PRODUCTION
SENDING IS LIVE** banner.

**11. Send to one prospect first.** Pause the campaign after the first send:

```bash
npm run outreach -- ops pause-all --reason "verifying first live send"
```

Check the message arrived, renders correctly in a real client, the unsubscribe
link works, and it did not land in spam. **Click your own unsubscribe link on a
test address** and confirm the suppression appears.

**12. Resume and let the remaining four go.**

```bash
npm run outreach -- ops resume-all
npm run outreach -- campaign start --id <campaign>
```

**13. Wait a week before scaling.** Watch: bounce rate (pause immediately above
3%), replies, and whether anyone unsubscribed. Then raise the daily limit
gradually — 5 → 10 → 20 over several weeks — and only enable follow-ups once
you have seen how people respond to the first email.

**The emergency stop, worth memorising:**

```bash
npm run outreach -- ops pause-all --reason "…"
```

It stops queued messages too, because the worker re-reads the flag inside the
send transaction for every job.
