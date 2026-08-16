# Operations

## Processes

Three, all from the same image/build:

| Process | Command | Count |
| --- | --- | --- |
| Web | `npm run start` | 1+ |
| Worker | `npm run worker` | 1 (safe to run more) |
| Scheduler | `npm run scheduler` | **exactly 1** |

The worker is safe to scale horizontally: job claiming uses
`FOR UPDATE SKIP LOCKED` and sending is idempotent. The scheduler should be a
single instance; if two run, enqueue dedupe keys prevent duplicate jobs, but a
single instance avoids the churn.

## Deployment

The simplest reliable arrangement, and the one this is designed for:

* One managed PostgreSQL instance (any provider; needs `SKIP LOCKED`, i.e. 9.5+).
* One web dyno/container.
* One worker container.
* One scheduler container (or the scheduler loop run under systemd / a
  platform cron calling `npm run scheduler -- --once`).

No Redis, no message broker, no object store, no service mesh. If the operator
outgrows this, the queue is the thing to replace, and the `JobQueue` interface
is where to do it.

### Order of operations for a deploy

1. `npm ci && npm run build`
2. `npm run db:migrate` (idempotent; safe to run on every deploy)
3. Restart worker and scheduler **before** the web tier if the migration adds
   columns the worker writes; after, otherwise.

### Rollback

Migrations are additive by policy: no destructive `DROP COLUMN` in a release
that the previous version is still running. To roll back, deploy the previous
image; the schema is forward-compatible by one release. Destructive changes are
split across two releases (stop writing → deploy → drop).

## Environment variables

See `.env.example` for the complete annotated list. The security-relevant ones:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Required. Never exposed to the browser. |
| `SESSION_SECRET` | Required, ≥32 chars. Rotating it invalidates all sessions. |
| `EMAIL_MODE` | `mock` (default) or `production`. Anything else fails startup. |
| `EMAIL_PROVIDER` | Required only when `EMAIL_MODE=production`. |
| `EMAIL_API_KEY` | Required only when `EMAIL_MODE=production`. |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | Required only when `EMAIL_MODE=production`. |
| `EMAIL_WEBHOOK_SECRET` | Required for webhook routes to accept anything. |
| `DAILY_SEND_LIMIT` etc. | Defaults; `settings` row overrides at runtime. |

There are **no** AI-related variables, and a test enforces that.

## Daily operation

The dashboard answers "what needs my attention today?": prospects awaiting
research, awaiting approval, emails scheduled today, follow-ups due, unread
replies, upcoming meetings, pipeline value.

## Emergency controls

**Stop everything, now:**

```bash
npm run outreach -- ops pause-all --reason "investigating deliverability"
```

or the red button in Settings → Operations. This sets
`settings.global_send_paused = true`. The worker re-reads it inside the send
transaction for every job, so already-queued jobs stop too. It does **not**
cancel jobs — resuming continues the pipeline.

**Resume:**

```bash
npm run outreach -- ops resume-all
```

**Other operational commands:**

```bash
npm run outreach -- ops failed          # failed sends with reasons
npm run outreach -- ops retry <id>      # re-queue one failed send
npm run outreach -- ops queue           # queue depth by kind and status
npm run outreach -- ops unstick         # release jobs stuck past visibility timeout
npm run outreach -- suppression list
npm run outreach -- prospect export --out prospects.csv
npm run outreach -- ops export-activities --out activities.csv
```

## Monitoring

Structured JSON logs to stdout. Every send-path log line carries
`request_id`, `user_id`, `prospect_id`, `company_id`, `contact_id`,
`campaign_id`, `message_id`, `event`, `status`, `timestamp`, and `error` where
applicable.

Counters exposed at `GET /api/metrics` (session-protected):
`emails_attempted`, `emails_sent`, `emails_failed`, `emails_bounced`,
`emails_blocked`, `replies`, `followups`, `queue_failures`, `provider_errors`,
`queue_depth`, `oldest_pending_job_age_seconds`.

### Alert on

| Condition | Why it matters |
| --- | --- |
| `bounce rate > 3%` over 50 sends | Deliverability damage; pause and investigate list quality |
| `oldest_pending_job_age_seconds > 3600` | Worker is dead or wedged |
| `provider_errors` rising | Provider outage or credential problem |
| Any `emails_blocked` with reason `APPROVAL_STALE` | Workflow confusion; content edited after approval |
| Any `emails_blocked` with reason `SUPPRESSED` | Something enqueued a job it should not have |
| Failed logins spiking | Credential attack |

## Backups

* Rely on the managed provider's automated backups plus point-in-time recovery.
* Additionally, a nightly `pg_dump --format=custom` retained 30 days:
  `pg_dump "$DATABASE_URL" -Fc -f "backup-$(date -u +%F).dump"`
* **Test the restore quarterly.** An untested backup is a hypothesis.
* Restore: `pg_restore -d "$NEW_DATABASE_URL" --clean --if-exists backup.dump`,
  then `npm run db:migrate`.

### What must survive a restore

The suppression list. If a restore rolls the database back past an
unsubscribe, someone who opted out becomes contactable again. After **any**
point-in-time restore, before resuming sending:

1. Keep `global_send_paused = true`.
2. Reconcile the suppression list against the provider's own unsubscribe/bounce
   records for the gap period.
3. Only then resume.

This is written down because it is the single most likely way this system
causes a compliance failure.

## Database hardening (recommended for production)

Two roles rather than one:

```sql
-- application role: no ability to rewrite history
REVOKE UPDATE, DELETE ON audit_logs FROM outreach_app;

-- worker role: no access to credentials
CREATE ROLE outreach_worker LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO outreach_worker;
REVOKE ALL ON users, sessions, user_profiles FROM outreach_worker;
```

## Retention

A scheduled job enforces `settings.retention_days_*` for activities, messages,
and webhook events. Suppression rows and audit logs are exempt. Retention is
off (`null`) by default — the operator opts in, because silently deleting
business history is worse than keeping it.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Nothing sends | `global_send_paused`; campaign status; `EMAIL_MODE`; worker process alive |
| "Blocked: OUTSIDE_SENDING_WINDOW" | Campaign windows vs prospect timezone; remember windows are *local* |
| "Blocked: APPROVAL_STALE" | Draft was edited after approval — re-approve |
| "Blocked: DAILY_LIMIT_REACHED" | Expected; resumes next day in the campaign timezone |
| Webhook 401 | `EMAIL_WEBHOOK_SECRET` mismatch, or clock skew beyond tolerance |
| Duplicate-looking emails | Check `message_attempts` — near-certainly two *different* messages, since a duplicate send is structurally prevented |
| Migration fails on deploy | Run `npm run db:migrate` manually and read the error; never edit an applied migration |
