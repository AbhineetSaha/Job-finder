# Outreach

A targeted prospecting, research, outreach, follow-up, CRM, and analytics
system for acquiring US freelance software engineering clients.

It is **not** a mass-emailing tool. Its purpose is to make it easy to find
companies where your services are genuinely relevant, research them properly,
write something specific to them, and keep you firmly in control of what gets
sent. Default limits are 20 emails a day.

**There is no AI in this application.** No AI API, no AI SDK, no LLM runtime,
no AI environment variable. Qualification, personalisation, sequencing,
scheduling, and analytics are deterministic functions or direct human input. A
test (`tests/unit/no-ai-dependency.test.ts`) fails the build if that ever
changes.

---

## Contents

- [Overview](#overview) · [Architecture](#architecture) · [Setup](#setup)
- [Configuration](#configuration) · [Database](#database) · [Email](#email)
- [Prospect workflow](#prospect-workflow) · [Human approval](#human-approval)
- [Campaigns](#campaigns) · [Workers](#workers) · [CLI](#cli)
- [Testing](#testing) · [Security](#security) · [Compliance](#compliance)
- [Deployment](#deployment) · [Monitoring](#monitoring) · [Troubleshooting](#troubleshooting)

---

## Overview

```
US prospect → qualified → researched → personalised draft → HUMAN APPROVAL
   → sent → reply → discovery call → proposal → contract
```

Everything before "sent" is cheap. The step *at* "sent" is deliberately
expensive: it requires an explicit human approval bound to a hash of the exact
content, and any subsequent edit invalidates it.

What the system does:

| | |
| --- | --- |
| **Prospecting** | Manual entry, CSV import with preview, deterministic deduplication |
| **Qualification** | Configurable 8-signal scoring; unknown scores zero and is never guessed |
| **Research** | Ten-question checklist with a source URL per claim |
| **Outreach** | Deterministic template engine; a missing variable is an error, never a blank |
| **Approval** | Mandatory, versioned, content-hash-bound |
| **Sending** | Queue + worker, rate limits, DST-correct sending windows, idempotent |
| **Follow-up** | Configurable sequences that stop the instant anything says stop |
| **CRM** | Pipeline, conversations, meetings, deals |
| **Analytics** | Conversion metrics that foreground meetings and revenue, not sends |

## Architecture

Three processes over one PostgreSQL database:

```
browser ──▶ web (Next.js)  ──┐
provider webhooks ───────────┼──▶  PostgreSQL  ◀── scheduler (enqueues due work)
                             └──▶               ◀── worker (claims jobs, sends)
                                                        │
                                                        └──▶ EmailProvider
```

The web process never sends email. It creates and approves drafts. All sending
happens in the worker, behind a full re-validation of every safety condition.

Layering is one-directional:

```
app/  ──▶  src/services/  ──▶  src/repositories & src/db/
                          ──▶  src/domain/     (PURE — no I/O, no imports upward)
                          ──▶  src/email/
```

`src/domain/` holds every rule that must never be violated, as pure functions
over plain data. That makes each rule unit-testable without a database, a
clock, or a network. The most important is `evaluateSendPreflight()` in
`src/domain/safety.ts`: one function, no default-allow branch, that answers
"may this specific email be sent right now?"

See `docs/architecture.md` for the full picture.

## Setup

**Requirements:** Node 20.11+, PostgreSQL 9.5+ (needs `FOR UPDATE SKIP LOCKED`).

```bash
# 1. Install
npm ci

# 2. Configure
cp .env.example .env
# Set DATABASE_URL. Generate a session secret:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# Leave EMAIL_MODE=mock. Real sending is opt-in and needs deliberate setup.

# 3. Create the schema
npm run db:migrate

# 4. Seed development data (10 fictional companies, 2 campaigns, a deal)
npm run db:seed

# 5. Run
npm run dev          # web,       http://localhost:3000
npm run worker       # in another terminal
npm run scheduler    # in a third terminal
```

The seed prints its login. All seeded companies, people, and addresses are
fictional and use RFC 2606 reserved domains (`.example`), which can never be
registered — a misconfigured run cannot reach a real mailbox.

For a real install, skip the seed and create your own account:

```bash
npm run outreach -- user create --email you@yourdomain.com --password '…' --name 'Your Name'
```

There is no public sign-up route by design.

Then fill in **Settings → Profile** (your name and title appear in the default
templates) and **Settings → Compliance** (a physical postal address, which
sending is blocked without).

## Configuration

`.env.example` is the annotated list. The ones that matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. Server-only, never exposed to the browser. |
| `SESSION_SECRET` | — | Required, ≥32 chars. Rotating invalidates all sessions. |
| `EMAIL_MODE` | `mock` | `mock` or `production`. Anything else fails startup. |
| `EMAIL_PROVIDER` | `mock` | `mock` or `resend`. |
| `EMAIL_API_KEY` / `EMAIL_FROM` / `EMAIL_REPLY_TO` | — | Required only in production mode. |
| `EMAIL_WEBHOOK_SECRET` | — | Webhook routes reject everything if unset. |
| `DAILY_SEND_LIMIT` | `20` | Deliberately conservative. |
| `HOURLY_SEND_LIMIT` | `5` | |
| `PER_DOMAIN_SEND_LIMIT` | `2` | Per recipient domain, per day. |
| `MIN/MAX_SEND_DELAY_SECONDS` | `90` / `600` | Spacing between sends. |
| `DEFAULT_TIMEZONE` | `America/New_York` | Fallback when a prospect's zone is unknown. |
| `FOLLOWUP_ENABLED` | `true` | When false, only step 0 is ever queued. |

Environment variables provide *defaults*. The per-user `settings` row overrides
them at runtime, so limits can be tightened — or all sending paused — without a
redeploy.

There are no `NEXT_PUBLIC_*` variables and no AI variables. Both are asserted
by tests.

## Database

PostgreSQL, Drizzle ORM, migrations checked into `drizzle/`.

```bash
npm run db:generate   # after editing src/db/schema.ts
npm run db:migrate    # apply (idempotent; safe on every deploy)
npm run db:seed       # development data
npm run db:reset      # drop and recreate — refuses in production config
```

28 tables. Company, contact, and prospect are separate so the same company can
hold several contacts without duplicating its data, and so deduplication is
reliable. Full schema rationale, index list, and query patterns are in
`docs/data-model.md`.

Several guarantees are enforced by the database rather than by application
code, so a race cannot defeat them:

- `contacts (user_id, normalized_email)` unique — one row per person
- `campaign_members (prospect_id) where status='ACTIVE'` unique — a prospect is
  in at most one live sequence
- `messages (campaign_member_id, campaign_step_id)` unique — one message per
  sequence step, permanently
- `message_attempts (idempotency_key)` unique — a retry cannot re-send

## Email

### Mock mode (the default)

Nothing leaves the machine. Messages are recorded in memory; delivery, bounces,
and replies can be simulated. The mock provider is the **only** provider
reachable unless `EMAIL_MODE=production`, so forgetting to configure something
fails safe rather than sending.

### Production mode

Requires, all together, or startup fails:

```
EMAIL_MODE=production
EMAIL_PROVIDER=resend
EMAIL_API_KEY=…
EMAIL_FROM=you@yourdomain.com
```

Plus a physical postal address in Settings, without which the worker blocks
every send with `MISSING_POSTAL_ADDRESS`.

Before enabling: configure SPF, DKIM, and DMARC for the sending domain, and
read your provider's cold-outreach policy. Some prohibit it on shared
infrastructure.

### Adding a provider

Implement `EmailProvider` (`src/email/provider.ts`) in
`src/email/providers/`, register it in the factory in `src/email/index.ts`.
Nothing else in the codebase imports a provider concretely.

## Prospect workflow

**1. Get prospects in.** Manual entry, or CSV import:

```csv
company_name,website,contact_name,contact_role,contact_email,source_url
Example Inc,https://example.com,John Doe,CTO,john@example.com,https://example.com/careers
```

Only `company_name` and `contact_email` are required. Import shows a preview
before writing anything; rejected rows are listed with reasons and downloadable
for repair.

Deduplication runs on four keys, in order: normalised email → company domain +
contact name → normalised company name → domain. `John.Doe@Example.com`,
`john.doe@example.com`, and `j.doe+leads@gmail.com` all resolve correctly.

**2. Qualify.** Eight signals, each `YES` / `NO` / `UNKNOWN`:

| Signal | Points |
| --- | --- |
| US company | 20 |
| SaaS / software company | 15 |
| Engineering team identified | 10 |
| Currently hiring engineers | 15 |
| Contractor / freelancer signal | 15 |
| Technology match | 10 |
| Identifiable engineering need | 10 |
| Decision maker identified | 5 |

90–100 High Priority · 75–89 Strong · 60–74 Potential · 40–59 Weak · 0–39 Poor.

**`UNKNOWN` scores zero and is recorded as unknown.** The engine never fills a
gap with an assumption, so a low score on an unresearched prospect means "go
find out", not "this company is bad". Weights are editable in Settings.

**3. Research.** Ten questions, each able to carry a source URL. A field
answered without a source renders as *unverified* in the review screen. There
is no code path that generates research text.

**4. Personalise.** Five operator-written fields — specific observation,
engineering signal, pain point, why relevant, specific offer — render into a
template. If a template needs a value you have not supplied, the draft is
**refused**. It will not emit a blank, a placeholder, or an invention.

## Human approval

The hard requirement, and the reason this is not a spam cannon.

```
draft → human approval → send
```

- Approval records `approved_by`, `approved_at`, `approval_version`, and a
  SHA-256 `content_hash` of recipient + subject + body.
- Editing after approval **revokes** it and returns the message to the review
  queue.
- At send time the worker recomputes the hash from the message as it exists
  *then* and compares. A mismatch blocks with `APPROVAL_STALE`.
- Approving from the UI submits the hash the reviewer actually saw; if the
  message changed since the page rendered, the approval is refused rather than
  applied to content nobody read.

Follow-ups are not exempt. Every step of every sequence is drafted into the
review queue and needs its own approval.

## Campaigns

A campaign is a sequence of steps, a set of sending windows, and a timezone.

Default sequence: Day 0 → +4 → +9 → +16. These are `campaign_steps` rows, not
constants — change them per campaign.

Sending windows are local wall-clock ranges (e.g. `09:00–11:30, 13:00–16:30`)
on chosen weekdays. Conversion uses the platform IANA database, so daylight
saving is correct by construction; a wall-clock time inside a spring-forward
gap resolves *forward*, never to an earlier instant. The prospect's timezone
wins when known, the campaign's otherwise.

**Stop conditions**, all enforced server-side and re-checked inside the send
transaction: reply received, meeting booked, `NOT_INTERESTED`,
`DO_NOT_CONTACT`, bounce, suppression, campaign paused, manual removal. A reply
arriving between a job being queued and being claimed still stops the send.

## Workers

| Process | Command | Count |
| --- | --- | --- |
| Web | `npm run start` | 1+ |
| Worker | `npm run worker` | 1 (safe to scale) |
| Scheduler | `npm run scheduler` | exactly 1 |

The scheduler turns approved, due messages into jobs. The worker claims jobs
with `FOR UPDATE SKIP LOCKED` and sends them — after rebuilding the entire
safety snapshot from the database. It does not trust anything the UI validated
earlier.

A transient block (paused, outside window, rate limited) is a *deferral*, not a
failure, so a long pause cannot exhaust a job's retry attempts.

Run the scheduler under cron instead of as a daemon with
`npm run scheduler -- --once`.

## CLI

```bash
npm run outreach -- help

npm run outreach -- user create --email you@example.com --password '…'
npm run outreach -- prospect import --file leads.csv --dry-run
npm run outreach -- prospect list --min-score 75
npm run outreach -- prospect score --id 6b38c866 --signals usCompany=YES,hiringEngineers=YES
npm run outreach -- prospect export --out prospects.csv

npm run outreach -- campaign list
npm run outreach -- campaign start --id a1b2c3d4

npm run outreach -- email queue
npm run outreach -- email preview --id 9f8e7d6c
npm run outreach -- email approve --id 9f8e7d6c --yes

npm run outreach -- suppression add --email someone@example.com
npm run outreach -- analytics

npm run outreach -- ops pause-all --reason "investigating deliverability"
npm run outreach -- ops resume-all
npm run outreach -- ops queue
npm run outreach -- ops failed
npm run outreach -- ops retry --message 9f8e7d6c
```

IDs accept a unique short prefix, as printed by the `list` commands.
`email approve` prints the message and requires `--yes` — approving something
you have not seen would defeat the point.

## Testing

```bash
npm test                  # everything (needs a PostgreSQL test database)
npm run test:unit         # pure domain logic, no database needed
npm run test:integration
npm run typecheck
```

Point `DATABASE_URL` in `.env.test` at a scratch database. **No test can send
real email:** the bootstrap aborts the entire run if `EMAIL_MODE=production`.

228 tests:

| Suite | Covers |
| --- | --- |
| `unit/domain` | normalisation, dedup, scoring, templates, roles, status machine, rate limits |
| `unit/safety` | every preflight guard, incomplete-snapshot handling, and the §70 safety review as executable assertions |
| `unit/scheduling` | DST transitions in both directions, window arithmetic, monotonic forward movement |
| `unit/csv` | RFC 4180 parsing, formula injection, hostile input |
| `unit/no-ai-dependency` | no AI package, import, env var, or hostname anywhere |
| `integration/workflow` | the full import → … → reply → CRM path |
| `integration/safety` | suppression, reply-stops-sequence, limits, global pause, four duplicate-send guards, deletion preserving suppression |
| `security/security` | cross-tenant access, injection, webhook forgery and replay, credentials, secrets |

## Security

Full model in `docs/security.md`. Summary:

- **Auth** — scrypt password hashing; opaque session tokens stored only as
  SHA-256 hashes; login rate-limited per IP and per account with a fixed-cost
  dummy verify for unknown accounts.
- **Authorization** — every query is scoped by `user_id`; a foreign id returns
  404, not 403, so an id is never confirmed.
- **Injection** — Drizzle parameterises everything; zero
  `dangerouslySetInnerHTML` in the codebase (asserted by a test); URLs
  validated to http/https before becoming an href; CSV formula triggers
  neutralised on import and quoted on export; CR/LF rejected in email headers.
- **CSRF** — double-submit token on every mutation, verified before the handler
  body runs.
- **Webhooks** — HMAC over the raw body with `timingSafeEqual`, a timestamp
  freshness window, and a unique event id that defeats replay. An unverified
  event is stored for forensics and never acted upon.
- **Secrets** — parsed once server-side; the env module throws if imported into
  a browser bundle; logs redact secret-shaped keys.

## Compliance

`docs/compliance.md` is the detailed version, including CAN-SPAM requirements
mapped to the specific control that supports each one.

> **This system is not "legally compliant" and this document does not claim
> that it is.** These are technical controls that support responsible
> commercial outreach. You remain responsible for complying with applicable
> laws and with every provider's terms of service. Several matters — state
> privacy statutes, whether a list source constitutes a "sale" of personal
> information, any outreach outside the US — require professional legal advice.

Controls provided: unsubscribe (one-click, no login, honoured synchronously),
do-not-contact, suppression that survives deletion, sender identification,
mandatory postal address, audit logging, source tracking, data deletion, and
configurable retention.

Deliberately **not** provided: open-tracking pixels, click trackers, domain or
IP rotation, subject-line obfuscation, hidden unsubscribe links, or anything
else that would evade spam filtering or provider policy.

## Deployment

The simplest reliable arrangement, and the one this is built for: one managed
PostgreSQL instance, one web container, one worker container, one scheduler.
No Redis, no broker, no object store.

```bash
npm ci && npm run build
npm run db:migrate
# start: web, worker, scheduler
```

Migrations are additive by policy so the previous release stays compatible;
rollback is redeploying the previous image. Destructive changes are split
across two releases. Details, including database role hardening and backup
procedure, in `docs/operations.md`.

**After any point-in-time restore**, keep sending paused and reconcile the
suppression list against your provider's unsubscribe records for the gap period
before resuming. A restore that rolls back past an unsubscribe makes someone
who opted out contactable again — the single most likely way this system causes
a compliance failure.

## Monitoring

Structured JSON logs to stdout; every send-path line carries `request_id`,
`user_id`, `prospect_id`, `contact_id`, `campaign_id`, `message_id`, `event`,
`status`, and `error`.

Counters at `GET /api/metrics` (session-protected): `emails_attempted`,
`emails_sent`, `emails_failed`, `emails_blocked`, `emails_bounced`, `replies`,
`followups`, `queue_failures`, `provider_errors`, `queue_depth`,
`oldest_pending_job_age_seconds`, `bounce_rate_percent`.

Alert on: bounce rate above 3% over 50 sends; oldest pending job older than an
hour; rising provider errors; any block with reason `SUPPRESSED` (something
enqueued work it should not have).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Nothing sends | Global pause; campaign status; `EMAIL_MODE`; worker alive |
| `OUTSIDE_SENDING_WINDOW` | Campaign windows vs the *prospect's* timezone |
| `APPROVAL_STALE` | Draft was edited after approval — re-approve |
| `MISSING_POSTAL_ADDRESS` | Settings → Compliance |
| `DAILY_LIMIT_REACHED` | Expected; resumes next day in the campaign timezone |
| Draft refuses to render | A template variable has no value. Fill it in, or edit the template. |
| Webhook 401 | Secret mismatch, or clock skew beyond tolerance |
| Duplicate-looking emails | Check `message_attempts` — a true duplicate is structurally prevented |
| Migration fails on deploy | Run `npm run db:migrate` manually and read the error; never edit an applied migration |

## Documentation

- `docs/architecture.md` — components, layering, sending pipeline, idempotency
- `docs/data-model.md` — schema, indexes, retention, deletion
- `docs/outreach-strategy.md` — ICP, qualification, what the system won't do
- `docs/security.md` — threat model and controls
- `docs/compliance.md` — CAN-SPAM mapping and operator responsibilities
- `docs/operations.md` — deploy, emergency controls, backups, monitoring
- `docs/implementation-plan.md` — the ten phases and their exit criteria
