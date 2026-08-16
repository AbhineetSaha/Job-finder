/**
 * Settings: profile, limits, compliance details, and the emergency controls.
 * Nothing about the operator is hard-coded anywhere in the application.
 */
import { desc, eq } from 'drizzle-orm';
import { requireUser } from '../../../src/lib/session.js';
import { getCsrfToken } from '../../../src/lib/csrf.js';
import { getDb } from '../../../src/db/client.js';
import { services as servicesTable } from '../../../src/db/schema.js';
import { getProfile } from '../../../src/services/users.js';
import { getConfig } from '../../../src/services/config.js';
import { getOperationsSnapshot } from '../../../src/services/ops.js';
import { listSuppressions } from '../../../src/services/suppression.js';
import { describeEmailMode } from '../../../src/email/index.js';
import { US_TIMEZONES } from '../../../src/domain/timezone.js';
import { Csrf, Empty, Notice, formatDate } from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const csrf = await getCsrfToken();
  const params = await searchParams;

  const [profile, config, ops, suppressions, services] = await Promise.all([
    getProfile(user.id),
    getConfig(user.id),
    getOperationsSnapshot(user.id),
    listSuppressions(user.id),
    getDb().select().from(servicesTable).where(eq(servicesTable.userId, user.id)).orderBy(desc(servicesTable.sortOrder)),
  ]);

  const mode = describeEmailMode();

  return (
    <>
      <h1>Settings</h1>

      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      {params.ok ? <Notice kind="ok">{params.ok}</Notice> : null}

      <h2>Operations</h2>
      <div className="card">
        <p className="small">
          Email mode: <strong>{mode.mode}</strong> (provider: {mode.provider}). Queue: {ops.queue.pending} pending,{' '}
          {ops.queue.claimed} in flight, {ops.queue.failed} failed.
        </p>
        <form action="/api/settings/pause" method="post" className="row">
          <Csrf token={csrf} />
          <input type="hidden" name="paused" value={config.globalSendPaused ? '0' : '1'} />
          {config.globalSendPaused ? null : (
            <input name="reason" placeholder="Reason for pausing" maxLength={300} style={{ width: 260 }} />
          )}
          <button type="submit" className={config.globalSendPaused ? 'primary' : 'danger'}>
            {config.globalSendPaused ? 'Resume sending' : 'Pause all sending'}
          </button>
        </form>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Pausing takes effect immediately, including for messages already queued — the worker
          re-reads this flag inside the send transaction for every job. Resuming also requires
          restarting each campaign, so it cannot happen by accident.
        </p>
      </div>

      <h2>Compliance</h2>
      <form action="/api/settings/compliance" method="post" className="card" style={{ maxWidth: 640 }}>
        <Csrf token={csrf} />
        <div className="field">
          <label htmlFor="postalAddress">Physical postal address *</label>
          <input
            id="postalAddress"
            name="postalAddress"
            defaultValue={config.postalAddress}
            maxLength={500}
            required
          />
          <div className="small muted">
            CAN-SPAM requires a valid physical postal address in every commercial message. Sending
            is blocked until this is set, and it is appended to every email automatically.
          </div>
        </div>
        <div className="field">
          <label htmlFor="advertisingDisclosure">Advertisement disclosure line</label>
          <input
            id="advertisingDisclosure"
            name="advertisingDisclosure"
            defaultValue={config.advertisingDisclosure}
            maxLength={300}
          />
        </div>
        <button type="submit" className="primary">
          Save
        </button>
      </form>

      <h2>Sending limits</h2>
      <form action="/api/settings/limits" method="post" className="card" style={{ maxWidth: 640 }}>
        <Csrf token={csrf} />
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="dailySendLimit">Daily limit</label>
            <input id="dailySendLimit" name="dailySendLimit" type="number" min={0} max={2000} defaultValue={config.rateLimits.dailyLimit} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="hourlySendLimit">Hourly limit</label>
            <input id="hourlySendLimit" name="hourlySendLimit" type="number" min={0} max={500} defaultValue={config.rateLimits.hourlyLimit} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="perDomainDailyLimit">Per-domain daily</label>
            <input id="perDomainDailyLimit" name="perDomainDailyLimit" type="number" min={0} max={500} defaultValue={config.rateLimits.perDomainDailyLimit} />
          </div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="minDelaySeconds">Minimum spacing (seconds)</label>
            <input id="minDelaySeconds" name="minDelaySeconds" type="number" min={0} max={86400} defaultValue={config.rateLimits.minDelaySeconds} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="maxDelaySeconds">Maximum spacing (seconds)</label>
            <input id="maxDelaySeconds" name="maxDelaySeconds" type="number" min={0} max={86400} defaultValue={config.rateLimits.maxDelaySeconds} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="defaultTimezone">Fallback timezone</label>
            <select id="defaultTimezone" name="defaultTimezone" defaultValue={config.defaultTimezone}>
              {US_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="small muted">
          A limit of zero means no sends, not unlimited. These defaults are deliberately
          conservative for cold outreach from a single sender.
        </p>
        <button type="submit" className="primary">
          Save limits
        </button>
      </form>

      <h2>Profile</h2>
      <form action="/api/settings/profile" method="post" className="card" style={{ maxWidth: 640 }}>
        <Csrf token={csrf} />
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="name">Name</label>
            <input id="name" name="name" defaultValue={profile?.name ?? ''} maxLength={200} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="title">Title</label>
            <input id="title" name="title" defaultValue={profile?.title ?? ''} maxLength={200} />
          </div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="email">Reply-to email</label>
            <input id="email" name="email" type="email" defaultValue={profile?.email ?? ''} maxLength={254} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="portfolioUrl">Portfolio URL</label>
            <input id="portfolioUrl" name="portfolioUrl" defaultValue={profile?.portfolioUrl ?? ''} maxLength={500} />
          </div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="hourlyRate">Hourly rate (USD)</label>
            <input id="hourlyRate" name="hourlyRate" type="number" min={0} step="1" defaultValue={profile?.hourlyRate ?? ''} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="minimumProjectValue">Minimum project value (USD)</label>
            <input id="minimumProjectValue" name="minimumProjectValue" type="number" min={0} step="1" defaultValue={profile?.minimumProjectValue ?? ''} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="availability">Availability</label>
            <input id="availability" name="availability" defaultValue={profile?.availability ?? ''} maxLength={200} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="bio">Bio</label>
          <textarea id="bio" name="bio" defaultValue={profile?.bio ?? ''} maxLength={2000} />
        </div>
        <p className="small muted">
          The default templates reference your name and title. Leaving them blank will make drafts
          fail to render rather than send an email with a gap in it.
        </p>
        <button type="submit" className="primary">
          Save profile
        </button>
      </form>

      <h2>Services</h2>
      <div className="card">
        <ul className="small">
          {services.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> — {s.description}
            </li>
          ))}
        </ul>
      </div>

      <h2>Suppression list</h2>
      <p className="muted small">
        {suppressions.length} active. A suppressed address can never receive automated outreach,
        and an unsubscribe can never be reversed.
      </p>
      <form action="/api/settings/suppression" method="post" className="card row">
        <Csrf token={csrf} />
        <div style={{ flex: '2 1 240px' }}>
          <label htmlFor="target">Email or domain</label>
          <input id="target" name="target" required maxLength={254} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label htmlFor="reason">Reason</label>
          <select id="reason" name="reason" defaultValue="MANUAL_BLOCK">
            <option value="MANUAL_BLOCK">Manual block</option>
            <option value="DO_NOT_CONTACT">Do not contact</option>
            <option value="INVALID">Invalid</option>
          </select>
        </div>
        <button type="submit">Suppress</button>
      </form>

      {suppressions.length === 0 ? (
        <Empty>Nothing suppressed.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Scope</th>
                <th>Reason</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {suppressions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.normalizedEmail ?? s.normalizedDomain}</td>
                  <td>{s.scope}</td>
                  <td>{s.reason}</td>
                  <td className="small muted">{formatDate(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Failed and blocked sends</h2>
      {ops.blockedMessages.length === 0 && ops.failedMessages.length === 0 ? (
        <Empty>Nothing failed or blocked.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...ops.blockedMessages, ...ops.failedMessages].map(({ message, contact }) => (
                <tr key={message.id}>
                  <td className="mono small">{contact.email}</td>
                  <td className="small">{message.subject}</td>
                  <td>{message.status}</td>
                  <td className="small muted">{message.blockedReason}</td>
                  <td>
                    <form action={`/api/settings/retry/${message.id}`} method="post">
                      <Csrf token={csrf} />
                      <button type="submit">Retry</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
