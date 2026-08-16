import { requireUser } from '../../../../src/lib/session.js';
import { getCsrfToken } from '../../../../src/lib/csrf.js';
import { Csrf, Notice } from '../../../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function NewProspectPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser();
  const csrf = await getCsrfToken();
  const params = await searchParams;

  return (
    <>
      <h1>Add prospect</h1>
      <p className="muted small">
        Duplicates are detected on normalised email, company domain plus contact name, and company
        name — so the same person cannot end up in the list twice.
      </p>

      {params.error ? <Notice kind="error">{params.error}</Notice> : null}

      <form action="/api/prospects" method="post" className="card" style={{ maxWidth: 620 }}>
        <Csrf token={csrf} />

        <div className="field">
          <label htmlFor="companyName">Company name *</label>
          <input id="companyName" name="companyName" required maxLength={300} />
        </div>
        <div className="field">
          <label htmlFor="website">Website</label>
          <input id="website" name="website" placeholder="https://example.com" maxLength={500} />
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="contactName">Contact name</label>
            <input id="contactName" name="contactName" maxLength={200} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="contactRole">Role</label>
            <input id="contactRole" name="contactRole" placeholder="CTO" maxLength={200} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="contactEmail">Contact email *</label>
          <input id="contactEmail" name="contactEmail" type="email" required maxLength={254} />
        </div>
        <div className="field">
          <label htmlFor="contactReason">Why this person?</label>
          <input
            id="contactReason"
            name="contactReason"
            placeholder="Named as the technical decision maker on their engineering page"
            maxLength={500}
          />
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="industry">Industry</label>
            <input id="industry" name="industry" maxLength={120} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="state">State</label>
            <input id="state" name="state" maxLength={60} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="timezone">Timezone</label>
            <select id="timezone" name="timezone" defaultValue="">
              <option value="">Unknown</option>
              <option value="America/New_York">America/New_York</option>
              <option value="America/Chicago">America/Chicago</option>
              <option value="America/Denver">America/Denver</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="sourceUrl">Source URL</label>
          <input
            id="sourceUrl"
            name="sourceUrl"
            placeholder="Where you found them"
            maxLength={500}
          />
        </div>
        <div className="field">
          <label htmlFor="notes">Notes</label>
          <textarea id="notes" name="notes" maxLength={2000} />
        </div>

        <button type="submit" className="primary">
          Add prospect
        </button>
      </form>
    </>
  );
}
