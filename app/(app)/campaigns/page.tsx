/** Campaign management: sequences, windows, and lifecycle controls. */
import { eq } from 'drizzle-orm';
import { requireUser } from '../../../src/lib/session.js';
import { getCsrfToken } from '../../../src/lib/csrf.js';
import { getDb } from '../../../src/db/client.js';
import { templates } from '../../../src/db/schema.js';
import { listCampaigns } from '../../../src/services/campaigns.js';
import { describeWindows } from '../../../src/domain/window.js';
import { US_TIMEZONES } from '../../../src/domain/timezone.js';
import { Csrf, Empty, Notice, formatDate } from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

const NEXT_STATUS: Record<string, { to: string; label: string }[]> = {
  DRAFT: [{ to: 'READY', label: 'Mark ready' }],
  READY: [{ to: 'RUNNING', label: 'Start' }],
  RUNNING: [
    { to: 'PAUSED', label: 'Pause' },
    { to: 'COMPLETED', label: 'Complete' },
  ],
  PAUSED: [
    { to: 'RUNNING', label: 'Resume' },
    { to: 'ARCHIVED', label: 'Archive' },
  ],
  COMPLETED: [{ to: 'ARCHIVED', label: 'Archive' }],
  ARCHIVED: [],
};

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const csrf = await getCsrfToken();
  const params = await searchParams;

  const [campaigns, templateRows] = await Promise.all([
    listCampaigns(user.id),
    getDb().select().from(templates).where(eq(templates.userId, user.id)),
  ]);

  return (
    <>
      <h1>Campaigns</h1>
      <p className="muted small">
        Sequence delays and sending windows are data, not constants — change them per campaign.
        Every step still requires human approval before it sends.
      </p>

      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      {params.ok ? <Notice kind="ok">{params.ok}</Notice> : null}

      {campaigns.length === 0 ? (
        <Empty>No campaigns yet.</Empty>
      ) : (
        campaigns.map(({ campaign, memberCount, activeCount, sentCount }) => (
          <div className="card" key={campaign.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{campaign.name}</strong> <span className="badge">{campaign.status}</span>
                <div className="small muted">{campaign.description || 'No description'}</div>
                <div className="small muted">
                  {describeWindows({
                    windows: campaign.sendingWindows,
                    sendDays: campaign.sendDays,
                    timeZone: campaign.timezone,
                  })}
                </div>
                <div className="small muted">
                  {memberCount} enrolled · {activeCount} active · {sentCount} sent · started{' '}
                  {formatDate(campaign.startedAt)}
                </div>
              </div>
              <div className="row">
                {(NEXT_STATUS[campaign.status] ?? []).map((action) => (
                  <form key={action.to} action={`/api/campaigns/${campaign.id}/status`} method="post">
                    <Csrf token={csrf} />
                    <input type="hidden" name="status" value={action.to} />
                    <button type="submit">{action.label}</button>
                  </form>
                ))}
              </div>
            </div>
          </div>
        ))
      )}

      <h2>New campaign</h2>
      {templateRows.length === 0 ? (
        <Empty>Create a template first.</Empty>
      ) : (
        <form action="/api/campaigns" method="post" className="card" style={{ maxWidth: 700 }}>
          <Csrf token={csrf} />
          <div className="field">
            <label htmlFor="name">Name *</label>
            <input id="name" name="name" required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="description">Description</label>
            <input id="description" name="description" maxLength={500} />
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="timezone">Default timezone</label>
              <select id="timezone" name="timezone" defaultValue="America/New_York">
                {US_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              <div className="small muted">A prospect&apos;s own timezone wins when known.</div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="windows">Sending windows</label>
              <input id="windows" name="windows" defaultValue="09:00-11:30, 13:00-16:30" />
              <div className="small muted">Local wall clock. End must be after start.</div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="sendDays">Sending days</label>
            <input id="sendDays" name="sendDays" defaultValue="1,2,3,4,5" />
            <div className="small muted">ISO weekdays, 1 = Monday.</div>
          </div>

          <h3>Sequence</h3>
          <p className="small muted">
            Delay is measured from the previous step. Leave a template blank to end the sequence
            there.
          </p>
          {[0, 1, 2, 3].map((i) => (
            <div className="row" key={i}>
              <div className="field" style={{ flex: '0 0 130px' }}>
                <label htmlFor={`delay${i}`}>Step {i + 1} delay (days)</label>
                <input
                  id={`delay${i}`}
                  name={`delay${i}`}
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={[0, 4, 5, 7][i]}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor={`template${i}`}>Template</label>
                <select id={`template${i}`} name={`template${i}`} defaultValue={templateRows[i]?.id ?? ''}>
                  <option value="">— none —</option>
                  {templateRows.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.kind})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}

          <button type="submit" className="primary">
            Create campaign
          </button>
        </form>
      )}
    </>
  );
}
