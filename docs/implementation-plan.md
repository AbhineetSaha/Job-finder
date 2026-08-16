# Implementation plan

Ten phases, built in order. Each phase ends with tests passing and the
previous phases still working. Status is recorded here as the build proceeds.

## Phase 1 — Foundation ✅

* `src/db/schema.ts` — full Drizzle schema; drizzle-kit migration checked in.
* `src/lib/env.ts` — Zod-parsed server-only environment, fails fast.
* `src/lib/auth.ts`, `src/lib/session.ts` — scrypt password hashing, opaque
  session tokens stored as SHA-256 hashes, HttpOnly/SameSite=Lax/Secure cookie.
* `src/lib/csrf.ts` — double-submit token on every mutating handler.
* `src/domain/normalize.ts` — deterministic email/domain/company normalisation.
* `src/domain/dedup.ts` — four-key match ladder.
* `src/domain/csv.ts` — RFC 4180 parser + Zod row validation + formula-injection
  neutralisation.
* Services + routes for manual prospect entry, CSV import with preview.

**Exit criteria:** `John.Doe@Example.com` and `john.doe@example.com` collapse to
one contact; import preview lists valid and invalid rows separately; invalid
rows are downloadable.

## Phase 2 — Qualification ✅

* `src/domain/qualification.ts` — the §13 weight table, configurable, tri-state
  signals (`YES`/`NO`/`UNKNOWN`), reason codes with points, band classification.
* Re-score writes a new `qualification_scores` row.

**Exit criteria:** unknown signals contribute zero and are never guessed;
weights come from settings; every point is traceable to a reason.

## Phase 3 — Research ✅

* Research screen mapped 1:1 to the §14 field list and the §15 ten questions.
* `research_sources` with per-claim URLs, scheme-validated.
* Checklist completeness computed, surfaced on the prospect and review queue.

**Exit criteria:** a claim can carry a source; nothing in the UI presents an
unsourced field as verified.

## Phase 4 — Outreach drafting ✅

* `src/domain/template.ts` — deterministic `{{variable}}` engine. Missing
  required variable = render error, never a blank or an invented value.
* Manual personalisation fields (`specific_observation`, `engineering_signal`,
  `pain_point`, `why_relevant`, `specific_offer`).
* Review screen showing everything §20 requires.
* `src/services/approval.ts` — approval records `content_hash`; edit revokes.

**Exit criteria:** editing an approved draft forces re-approval.

## Phase 5 — Email ✅

* `EmailProvider` interface, `mock` and `resend` adapters, factory that refuses
  a real provider unless `EMAIL_MODE=production`.
* Suppression list with all five reasons, checked on every path.
* Bounce classification: permanent → suppress + stop sequence.

**Exit criteria:** with default configuration it is not possible to reach a
real provider.

## Phase 6 — Campaigns and queue ✅

* Campaigns, steps, members, state machine.
* `jobs` table, `claimJobs()` with `SKIP LOCKED`, worker with backoff, sweeper.
* `src/domain/window.ts` + `src/domain/timezone.ts` — DST-correct windows.
* `src/domain/ratelimit.ts` — daily/hourly/per-domain.
* `src/domain/safety.ts` — the single preflight gate.

**Exit criteria:** the worker re-validates everything; global pause halts
already-queued jobs.

## Phase 7 — Replies ✅

* Webhook route with HMAC verification, replay table, and event fan-out.
* Reply → stop sequence, mark `REPLIED`, activity, notification.
* Manual reply classification only.

**Exit criteria:** a reply arriving between enqueue and send still stops the
send.

## Phase 8 — CRM ✅

* Pipeline board, explicit status transitions through the state machine.
* Meetings, deals, conversation timeline.

## Phase 9 — Analytics ✅

* Prospect / outreach / sales / conversion metrics, computed with aggregate SQL.

## Phase 10 — Hardening ✅

* CLI, seed data, admin operations, structured logging, full test suite,
  security review, outreach safety review, README.

## Ordering rationale

The safety machinery (Phases 5–7) is built before the CRM and analytics
(Phases 8–9) because the CRM is where sending mistakes become visible but the
sending path is where they are made. Analytics last, because it only reads.
