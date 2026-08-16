/**
 * CSV import with a mandatory preview step (brief §10). Nothing is written
 * until the operator confirms, and rejected rows are downloadable for repair.
 */
import { requireUser } from '../../../src/lib/session.js';
import { getCsrfToken } from '../../../src/lib/csrf.js';
import { IMPORT_COLUMNS, REQUIRED_COLUMNS } from '../../../src/domain/csv.js';
import { Notice } from '../../_components/ui.js';
import { ImportPreview } from './preview.js';

export const dynamic = 'force-dynamic';

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  await requireUser();
  const csrf = await getCsrfToken();
  const params = await searchParams;

  const optional = IMPORT_COLUMNS.filter(
    (column) => !(REQUIRED_COLUMNS as readonly string[]).includes(column),
  );

  return (
    <>
      <h1>Import prospects</h1>
      <p className="muted small">
        You will see a preview before anything is saved. Rows that fail validation are listed with
        reasons and can be downloaded, fixed, and re-imported.
      </p>

      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      {params.ok ? <Notice kind="ok">{params.ok}</Notice> : null}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Columns</h3>
        <p className="small">
          Required: <span className="mono">{REQUIRED_COLUMNS.join(', ')}</span>
        </p>
        <p className="small muted">
          Optional: <span className="mono">{optional.join(', ')}</span>
        </p>
        <pre className="email">
{`company_name,website,contact_name,contact_role,contact_email,source_url
Example Inc,https://example.com,John Doe,CTO,john@example.com,https://example.com/careers`}
        </pre>
      </div>

      <ImportPreview csrf={csrf} />
    </>
  );
}
