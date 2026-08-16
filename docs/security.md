# Security model

Prospect and contact records are treated as sensitive business data: named
individuals, their work email addresses, their employer, and the operator's
private commercial notes about them.

## Threat model

| Actor | Capability | Primary mitigations |
| --- | --- | --- |
| Unauthenticated internet user | Reaches the public URL and webhook endpoints | Session gate on every page and handler; webhook HMAC + replay table |
| Authenticated operator | Full access to their own rows | Row-scoped queries by `user_id`; audit log |
| Malicious CSV author | Supplies the import file | Row-level Zod validation, cell sanitisation, URL allowlist, size caps |
| Malicious email provider payload | Posts to the webhook | Signature verification, freshness window, unique event id |
| Someone with the database | Reads at rest | Password + session tokens stored only as hashes; secrets never in DB |
| The operator, by accident | Mass-send, wrong recipient, stale content | Approval currency, limits, global pause, preflight |

## Authentication

* Passwords hashed with **scrypt** (`node:crypto`, N=16384, r=8, p=1, 64-byte
  key, 16-byte random salt), stored as `scrypt$N$r$p$salt$hash`. Verification is
  `timingSafeEqual`.
* Login is rate-limited per IP *and* per email, with a fixed-cost dummy verify
  on unknown accounts so response timing does not reveal account existence.
* Sessions are 32 bytes of `randomBytes`, base64url. The **hash** is stored;
  the raw value exists only in the cookie. Cookie is `HttpOnly`, `SameSite=Lax`,
  `Secure` in production, `Path=/`, with an absolute expiry and a sliding
  `last_used_at`.
* Logout deletes the row, so a stolen cookie dies immediately.
* Registration is closed by default: the first user is created by
  `npm run outreach -- user create`. There is no public sign-up route.

## Authorization

Every repository function takes `userId` and filters on it. There is no
"fetch by id" that omits the ownership predicate — this is enforced by making
the repository functions require the field, and covered by
`tests/security/authorization.test.ts`, which asserts that user B receives 404
(not 403, to avoid confirming existence) for every one of user A's entities.

## Input validation

Zod schemas at every boundary. Parse, don't validate: handlers receive typed
data or return 400. Numeric limits are clamped, not merely checked. Strings
have maximum lengths matching column widths so a payload cannot cause a
database error to surface as a 500.

## Injection

* **SQL** — Drizzle parameterises everything. No string-concatenated SQL exists
  in the codebase; the one place raw SQL is used (`SKIP LOCKED` claim and
  aggregate analytics) uses `sql` tagged templates with bound parameters.
  `tests/security/sql-injection.test.ts` drives classic payloads through the
  search, filter, and import paths and asserts data integrity.
* **XSS** — React escapes by default and the codebase contains **zero**
  occurrences of `dangerouslySetInnerHTML`; a test asserts this. Imported HTML
  is never rendered as markup. URLs from prospect data are validated to
  `http`/`https` before becoming an `href`, and rendered with
  `rel="noopener noreferrer nofollow"`.
* **CSV formula injection** — cells beginning `=`, `+`, `-`, `@`, tab or CR are
  prefixed with `'` on export and stripped of the leading control character on
  import, so a spreadsheet opening an exported file cannot execute a formula.
* **Header injection** — subject and recipient are rejected if they contain
  CR or LF before reaching the provider.

## CSRF

All mutations are `POST` and require a double-submit token: a random value in
a `SameSite=Lax` cookie must match the `_csrf` form field, compared with
`timingSafeEqual`. `GET` handlers never mutate. Webhook routes are exempt (no
cookie is involved) and are instead protected by HMAC.

## Webhooks

1. Reject if `EMAIL_WEBHOOK_SECRET` is unset.
2. Read the raw body (never the parsed body) and compute HMAC-SHA256.
3. Compare with `timingSafeEqual`.
4. Reject if the signed timestamp is more than `WEBHOOK_TOLERANCE_SECONDS`
   (default 300) from now.
5. Insert into `webhook_events` keyed on the provider's event id; a unique
   violation means replay, and the event is acknowledged without reprocessing.
6. Only then act on it.

`tests/security/webhook-forgery.test.ts` covers: no signature, wrong signature,
right signature over a different body, stale timestamp, and replay.

## Secret handling

* `src/lib/env.ts` throws at import time if it is ever loaded in a browser
  bundle, and is imported only from server files.
* No secret is passed as a prop to a client component. There are no
  `NEXT_PUBLIC_*` variables at all in `.env.example`.
* `tests/security/secret-exposure.test.ts` scans the production build output
  (`.next/static`) for the literal values of `DATABASE_URL`, `EMAIL_API_KEY`,
  `SESSION_SECRET`, and `EMAIL_WEBHOOK_SECRET` set to sentinel values, and
  fails if any appears.
* Logs redact anything matching secret-shaped keys before serialisation.

## Rate limiting

* Login: per-IP and per-account, with lockout backoff.
* Webhooks: per-source token bucket.
* Sending: daily / hourly / per-domain, enforced in the worker inside the send
  transaction, counted from `send_ledger`.

## Audit logging

Append-only `audit_logs`. The application contains no UPDATE or DELETE against
it. `docs/operations.md` documents revoking those privileges from the
application role at the database level for defence in depth. Every action in
brief §47 is recorded with actor, timestamp, entity, action, and metadata.

## Worker permissions

The worker uses the same database role as the web app today (single-operator
deployment). For a hardened deployment, `docs/operations.md` specifies a
separate role with no access to `users`, `sessions`, or `user_profiles`.

## Known residual risks

1. **Session fixation on privilege change** — there is only one role today, so
   there is no privilege escalation path to protect against. If roles are ever
   added, sessions must be rotated on role change.
2. **No 2FA.** Single-operator system behind a single password. Adding TOTP is
   straightforward and is listed in future improvements.
3. **No encryption at rest inside the application.** Prospect data is stored in
   plaintext columns; protection relies on the database's own at-rest
   encryption and network isolation. Documented rather than hidden.
4. **Provider trust.** A compromised email provider could report false
   deliveries or bounces. Bounces cause suppression (fail-safe direction), but
   forged "delivered" events would overstate metrics.
5. **The operator can still send a bad email.** Every technical control here
   protects against *accidental* and *automated* mistakes. It cannot protect
   against a human deliberately approving a bad message — nor should it try.
