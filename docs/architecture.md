# Architecture

## 0. Repository baseline (inspection result)

The repository was empty at the start of this work: a bare git repo on branch
`claude/freelance-client-acquisition-qv8fi6` with no commits, no source, no
package manifest, no CI, no infrastructure.

That inspection result determines everything below. There was no existing
stack, database, auth, UI kit, email infrastructure, queue, deployment target
or test harness to conform to or preserve, so the stack was chosen to match the
operator's own primary technologies (stated in the brief) rather than to match
an incumbent codebase:

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict) | Operator's stack; strong typing required by brief §67 |
| Web | Next.js 15 App Router + React 19 | Operator's stack; server-rendered pages keep secrets server-side |
| Database | PostgreSQL 16 | Operator's stack; needed for `FOR UPDATE SKIP LOCKED` queue |
| ORM | Drizzle ORM + drizzle-kit | Operator's stack; SQL-first, generates checked-in migrations |
| Validation | Zod | Single source of truth for input parsing at every trust boundary |
| Tests | Vitest | Fast, native ESM/TS, one runner for unit + integration |
| Queue | PostgreSQL table + `SKIP LOCKED` | No Redis/broker to operate; transactional with business data |
| Auth | First-party session cookies + scrypt | No third-party auth dependency, no external identity service |
| Scheduling | `Intl.DateTimeFormat` with IANA zones | DST-correct without a date library dependency |

Total runtime dependency count is seven: `next`, `react`, `react-dom`,
`drizzle-orm`, `pg`, `zod`, and (transitively) nothing else of substance. No AI
SDK, no AI client, no LLM runtime, no AI environment variable exists anywhere
in the system. See §9.

## 1. System shape

Three processes share one PostgreSQL database:

```
                        ┌──────────────────────────┐
   browser ──HTTPS──▶   │  web (Next.js)           │
                        │  pages + route handlers  │
                        └────────────┬─────────────┘
                                     │
   provider webhooks ──HTTPS──────▶  │ (verified, constant-time)
                                     │
                        ┌────────────▼─────────────┐
                        │  PostgreSQL              │
                        │  business data + queue   │
                        └────────────▲─────────────┘
                                     │
                        ┌────────────┴─────────────┐   ┌──────────────────┐
                        │  worker                  │──▶│  EmailProvider   │
                        │  claims + sends          │   │  mock | resend   │
                        └────────────▲─────────────┘   │  | smtp-less...  │
                                     │                 └──────────────────┘
                        ┌────────────┴─────────────┐
                        │  scheduler               │
                        │  enqueues due sequence   │
                        │  steps, sweeps stuck jobs│
                        └──────────────────────────┘
```

The web process never sends email. It only creates and approves drafts and
enqueues jobs. All sending happens in the worker, behind a full re-validation
of every safety condition (brief §31: *"Do not trust the UI's earlier
validation"*).

## 2. Layering

```
app/                      Next.js pages (server components) + route handlers
  └── depends on ──▶ src/services/     orchestration, transactions, audit
        └── depends on ──▶ src/repositories/  Drizzle queries, no business rules
        │     └── depends on ──▶ src/db/      schema, client, migrations
        └── depends on ──▶ src/domain/        PURE business logic, zero I/O
        └── depends on ──▶ src/email/         provider interface + adapters
src/queue/                worker + scheduler, depend on services + domain
src/cli/                  thin wrapper over services
```

The dependency rule is one-directional: `domain` imports nothing from
`repositories`, `services`, `db`, `email`, or `app`. It is a set of pure
functions over plain data.

### Why the domain layer is pure

Every rule in the brief that must "never" be violated — no send without
approval, no send to a suppressed contact, no duplicate sends, no sending
outside a window, no exceeding limits — is expressed as a pure function in
`src/domain/`. That makes each rule directly unit-testable without a database,
a clock, or a network, and makes the safety review in
`docs/security.md` a matter of reading a handful of small files rather than
auditing the whole application.

The most important of these is `evaluateSendPreflight()` in
`src/domain/safety.ts`. It takes an immutable snapshot of everything relevant
to one prospective send and returns either `{ok: true}` or
`{ok: false, reason, detail}`. It has no fallthrough `allow` branch: the
function is written as a list of guards over a `SendPreflightSnapshot` whose
fields are all required, so a field that cannot be determined cannot be omitted
— it must be passed explicitly, and unknown values fail closed (brief §66.15).

## 3. Request / trust boundaries

| Boundary | Untrusted input | Control |
| --- | --- | --- |
| Browser → route handler | form bodies, query strings | Zod parse, session check, CSRF double-submit on mutations |
| CSV upload | every cell | Zod row schema, formula-injection neutralisation, URL scheme allowlist, size + row caps |
| Provider webhook → route handler | entire payload | HMAC signature verified with `timingSafeEqual`, timestamp freshness window, replay table |
| Rendered prospect data → HTML | company/contact/research text | React escaping only; no `dangerouslySetInnerHTML` anywhere in the codebase |
| Rendered prospect data → email body | same | Template engine escapes nothing but *never* interpolates unknown variables; body is plain text |
| Environment | secrets | parsed once server-side in `src/lib/env.ts`; module is import-guarded against client bundles |

## 4. The sending pipeline

```
draft created  ──▶ draft edited ──▶ approval (records content hash)
                                          │
                                          ▼
                            scheduled_at computed from
                            campaign sequence + sending window
                            + prospect timezone (DST-correct)
                                          │
                                          ▼
                            job row inserted (unique idempotency key)
                                          │
                        ┌─────────────────▼──────────────────┐
                        │ worker: claim job                  │
                        │   FOR UPDATE SKIP LOCKED           │
                        └─────────────────┬──────────────────┘
                                          ▼
                            build SendPreflightSnapshot
                            (single transaction, row-locked contact)
                                          │
                                          ▼
                            evaluateSendPreflight()  ── fail ──▶ record blocked
                                          │                      reason + audit,
                                        pass                     do not send
                                          ▼
                            insert message_attempt (idempotency_key UNIQUE)
                                          │
                                          ▼
                            provider.sendEmail()
                                          │
                        ┌─────────────────┴──────────────────┐
                        ▼                                    ▼
                   success                               failure
                   record provider id                    classify: permanent →
                   mark SENT, log audit                  suppress; transient →
                   schedule next step                    retry w/ backoff, cap
```

### Idempotency

Three independent mechanisms, any one of which alone prevents a duplicate:

1. **`message_attempts.idempotency_key`** — `UNIQUE`. Derived deterministically
   from `messageId + attemptNumber`. The row is inserted *before* the provider
   call. A crashed worker that retries the same attempt hits the unique
   violation and refuses to re-send.
2. **`messages` uniqueness per sequence step** — a partial unique index on
   `(campaign_member_id, campaign_step_id)` means one sequence step can produce
   at most one message per enrolled prospect, forever.
3. **Preflight duplicate check** — the snapshot carries
   `alreadySentForStep`, and `evaluateSendPreflight` rejects when true.

### Approval currency

An approval stores `content_hash` (SHA-256 over subject + body + recipient).
The preflight recomputes the hash from the message as it exists at send time
and compares. Any edit after approval changes the hash, invalidates the
approval, and the send is blocked with `APPROVAL_STALE` (brief §21).

## 5. Scheduling and time

* All timestamps are stored as `timestamptz` and handled as UTC in code.
* Sending windows are expressed as local wall-clock ranges (e.g. `09:00–11:30`)
  plus an IANA zone.
* Conversion uses `Intl.DateTimeFormat` with `timeZone` and a fixed-point
  search over UTC instants (`src/domain/timezone.ts`), which is DST-correct by
  construction because the platform tz database does the work. Spring-forward
  gaps and autumn-back repeats are both handled explicitly and tested.
* Prospect timezone wins when known; otherwise the campaign default applies
  (brief §28).

## 6. Queue design

A single `jobs` table:

```sql
SELECT id FROM jobs
 WHERE status = 'PENDING' AND run_after <= now()
 ORDER BY run_after
 FOR UPDATE SKIP LOCKED
 LIMIT $1
```

Claiming sets `status='CLAIMED'`, `claimed_at=now()`, `claimed_by=$worker`.
A sweeper re-queues jobs claimed longer than the visibility timeout, bounded by
`attempts < max_attempts`. Retries use exponential backoff with jitter.

Chosen over Redis/BullMQ because the queue and the business data are then in
one transaction: a job and the `message` row it refers to commit or roll back
together, which removes an entire class of "job exists, message doesn't" bugs.
It scales to far more than a single-operator freelance pipeline needs.

## 7. Email provider abstraction

```ts
interface EmailProvider {
  readonly name: string;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  getMessage?(providerMessageId: string): Promise<ProviderMessage>;
  verifyWebhook?(req: WebhookRequest): Promise<WebhookVerification>;
  parseWebhook?(req: WebhookRequest): ProviderEvent[];
}
```

Adapters live in `src/email/providers/`. Nothing outside that directory
imports a provider concretely; everything resolves through
`getEmailProvider()`. Two adapters ship:

* **`mock`** — default, and the *only* provider reachable unless
  `EMAIL_MODE=production` is set explicitly. Persists what would have been sent
  and exposes delivery/bounce/reply simulation.
* **`resend`** — a real adapter written against the provider's HTTP API with
  `fetch`, so it adds no dependency. Selected only with explicit production
  configuration.

## 8. Global kill switch

`settings.global_send_paused` is checked (a) by the UI, (b) by the scheduler
before enqueueing, and (c) by the worker inside the send transaction as part of
the preflight snapshot. Because the worker re-reads it per job, flipping the
switch stops sending within one job, including for jobs already queued
(brief §56).

## 9. AI: explicitly absent

There is no AI API client, no AI SDK, no local model runtime, no inference
server, no AI environment variable, and no code path that would call one.
Qualification, personalisation, sequencing, scheduling, reply classification,
and analytics are deterministic functions or direct human input.

A CI-enforceable check lives in `tests/unit/no-ai-dependency.test.ts`: it walks
`package.json` plus the whole source tree and fails on any AI vendor package,
AI-sounding environment variable, or known AI API hostname. This is a test, not
a comment, so the constraint cannot silently rot.

## 10. What is deliberately not built

Per brief §64, the first version excludes: automatic prospect scraping,
enrichment vendors, machine learning, automatic reply generation, automatic
proposal generation, marketing-automation branching logic, and microservices.
`ProspectSource` exists as an interface with `CsvSource` and `ManualSource`
implementations so a licensed data source can be added later without touching
the core (brief §11).
