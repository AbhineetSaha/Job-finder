'use client';

/**
 * Client-side import preview.
 *
 * The parsing here uses exactly the same pure function the server uses, so the
 * preview matches what will actually happen. It is a convenience, never a
 * trust boundary: the server re-parses and re-validates the submitted CSV on
 * commit, and the database constraints are the final authority on duplicates.
 */
import { useMemo, useState } from 'react';
import { invalidRowsToCsv, parseImportCsv } from '../../../src/domain/csv.js';
import { CSRF_FIELD } from '../../../src/lib/constants.js';

export function ImportPreview({ csrf }: { csrf: string }) {
  const [text, setText] = useState('');
  const result = useMemo(() => (text.trim() ? parseImportCsv(text) : null), [text]);

  const downloadInvalid = () => {
    if (!result || result.invalid.length === 0) return;
    const blob = new Blob([invalidRowsToCsv(result.invalid)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'invalid-rows.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
  };

  return (
    <>
      <div className="card">
        <div className="field">
          <label htmlFor="file">CSV file</label>
          <input
            id="file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        <div className="field">
          <label htmlFor="csv">…or paste CSV directly</label>
          <textarea
            id="csv"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ minHeight: 150, fontFamily: 'var(--mono)', fontSize: 13 }}
            placeholder="company_name,website,contact_name,contact_role,contact_email,source_url"
          />
        </div>
      </div>

      {result === null ? null : result.missingColumns.length > 0 ? (
        <div className="notice error">
          Missing required column(s): <span className="mono">{result.missingColumns.join(', ')}</span>.
          Nothing can be imported until they are present.
        </div>
      ) : (
        <>
          <h2>Preview</h2>
          <p className="muted small">
            {result.valid.length} row(s) will be imported · {result.invalid.length} rejected
            {result.truncated ? ' · file truncated to the first 5000 rows' : ''}
            {result.unknownColumns.length > 0
              ? ` · ignoring unknown column(s): ${result.unknownColumns.join(', ')}`
              : ''}
          </p>

          {result.valid.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Company</th>
                    <th>Contact</th>
                    <th>Role</th>
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {result.valid.slice(0, 50).map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="muted small">{row.rowNumber}</td>
                      <td>{row.companyName}</td>
                      <td>{row.contactName || <span className="muted">—</span>}</td>
                      <td>
                        {row.contactRole ?? '—'}
                        {row.roleCategory === 'OTHER' || row.roleCategory === 'UNKNOWN' ? (
                          <span className="badge warn" style={{ marginLeft: 6 }}>
                            not a decision maker
                          </span>
                        ) : null}
                      </td>
                      <td className="mono small">{row.contactEmail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.valid.length > 50 ? (
                <p className="muted small">Showing the first 50 of {result.valid.length}.</p>
              ) : null}
            </div>
          ) : null}

          {result.invalid.length > 0 ? (
            <>
              <h3>Rejected rows</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Company</th>
                      <th>Email</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.invalid.slice(0, 50).map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="muted small">{row.rowNumber}</td>
                        <td>{row.raw.company_name}</td>
                        <td className="mono small">{row.raw.contact_email}</td>
                        <td className="small" style={{ color: 'var(--danger)' }}>
                          {row.errors.join('; ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={downloadInvalid} style={{ marginTop: 8 }}>
                Download rejected rows
              </button>
            </>
          ) : null}

          {result.valid.length > 0 ? (
            <form action="/api/prospects/import" method="post" style={{ marginTop: 16 }}>
              <input type="hidden" name={CSRF_FIELD} value={csrf} />
              <input type="hidden" name="csv" value={text} />
              <button type="submit" className="primary">
                Import {result.valid.length} prospect{result.valid.length === 1 ? '' : 's'}
              </button>
              <p className="small muted" style={{ marginTop: 6 }}>
                The server re-validates every row and re-checks for duplicates against your existing
                prospects before writing anything.
              </p>
            </form>
          ) : null}
        </>
      )}
    </>
  );
}
