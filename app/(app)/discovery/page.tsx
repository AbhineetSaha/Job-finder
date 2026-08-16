/**
 * Discovery: configure sources, run them, and review what they found.
 *
 * Nothing on this page can send an email. Candidates are leads for you to
 * judge; promoting one creates a prospect that still has to be researched,
 * drafted, and approved like any other.
 */
import Link from 'next/link';
import { requireUser } from '../../../src/lib/session.js';
import { getCsrfToken } from '../../../src/lib/csrf.js';
import {
  getDiscoveryCounts,
  listCandidates,
  listDiscoveryRuns,
  listDiscoverySources,
  listSources,
  type CandidateFilters,
} from '../../../src/services/discovery.js';
import { Csrf, Empty, Notice, SafeLink, Stat, formatDate } from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

const CONTACTABILITY_LABEL: Record<string, { text: string; className: string }> = {
  OPT_OUT_REGIME: { text: 'US — opt-out regime', className: 'ok' },
  CONSENT_REQUIRED: { text: 'Consent required', className: 'warn' },
  EXCLUDED: { text: 'Excluded', className: 'danger' },
  UNKNOWN: { text: 'Country unknown', className: '' },
};

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const csrf = await getCsrfToken();
  const params = await searchParams;

  const filters: CandidateFilters = {
    status: (params.status as CandidateFilters['status']) ?? 'NEW',
    ...(params.minScore ? { minMatchScore: Number(params.minScore) } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.hasEmail === '1' ? { hasEmail: true } : {}),
    ...(params.hasFunding === '1' ? { hasFunding: true } : {}),
  };

  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const [sources, configured, runs, counts, candidates] = await Promise.all([
    Promise.resolve(listSources()),
    listDiscoverySources(user.id),
    listDiscoveryRuns(user.id, 5),
    getDiscoveryCounts(user.id),
    listCandidates(user.id, filters, page, 25),
  ]);

  return (
    <>
      <h1>Discovery</h1>
      <p className="muted small">
        Automated sourcing finds companies. It never creates prospects and never sends anything —
        everything below is staged for you to judge.
      </p>

      <div className="grid">
        <Stat label="Awaiting review" value={counts.new} />
        <Stat label="Promoted" value={counts.promoted} />
        <Stat label="Rejected" value={counts.rejected} />
        <Stat label="Already known" value={counts.duplicate} />
      </div>

      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      {params.ok ? <Notice kind="ok">{params.ok}</Notice> : null}

      {/* ---------------------------------------------------------------- */}
      <h2>Sources</h2>

      {configured.length === 0 ? (
        <Empty>No sources configured yet. Add one below.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Last run</th>
                <th>Config</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {configured.map((source) => (
                <tr key={source.id}>
                  <td>{source.name}</td>
                  <td className="small muted">{source.kind}</td>
                  <td className="small muted">{formatDate(source.lastRunAt)}</td>
                  <td className="small mono">{JSON.stringify(source.config).slice(0, 70)}</td>
                  <td>
                    <div className="row">
                      <form action={`/api/discovery/sources/${source.id}/run`} method="post">
                        <Csrf token={csrf} />
                        <button type="submit" className="primary">
                          Run
                        </button>
                      </form>
                      <form action={`/api/discovery/sources/${source.id}/delete`} method="post">
                        <Csrf token={csrf} />
                        <button type="submit">Remove</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Add a source</h3>
      <form action="/api/discovery/sources" method="post" className="card" style={{ maxWidth: 720 }}>
        <Csrf token={csrf} />
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="kind">Source</label>
            <select id="kind" name="kind" required>
              {sources.map((source) => (
                <option key={source.kind} value={source.kind}>
                  {source.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="name">Name this configuration</label>
            <input id="name" name="name" required maxLength={200} placeholder="Postgres startups, HN" />
          </div>
        </div>

        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="keywords">Keywords (HN — all must appear)</label>
            <input id="keywords" name="keywords" placeholder="postgres, remote" maxLength={300} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="languages">Languages (GitHub)</label>
            <input id="languages" name="languages" placeholder="TypeScript, Java" maxLength={200} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="sicPrefixes">SIC prefixes (SEC)</label>
            <input id="sicPrefixes" name="sicPrefixes" placeholder="73" maxLength={100} />
          </div>
        </div>

        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="limit">Max candidates per run</label>
            <input id="limit" name="limit" type="number" min={1} max={300} defaultValue={50} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="minMatchScore">Minimum match score</label>
            <input id="minMatchScore" name="minMatchScore" type="number" min={0} max={100} defaultValue={30} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="token">GitHub token (optional)</label>
            <input id="token" name="token" type="password" maxLength={200} autoComplete="off" />
            <div className="small muted">Raises the API rate limit. Stored server-side only.</div>
          </div>
        </div>

        <button type="submit" className="primary">
          Add source
        </button>
      </form>

      <details className="card">
        <summary className="small">What each source accesses, and on what basis</summary>
        <ul className="small" style={{ marginTop: 10 }}>
          {sources.map((source) => (
            <li key={source.kind} style={{ marginBottom: 8 }}>
              <strong>{source.name}</strong>
              <div className="muted">{source.description}</div>
              <div className="muted">Basis: {source.accessBasis}</div>
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ marginBottom: 0 }}>
          No source bypasses a CAPTCHA, a login, a rate limit, or a robots.txt rule, and none of
          them guesses an email address — only addresses a company or person published themselves
          are ever captured.
        </p>
      </details>

      {runs.length > 0 ? (
        <>
          <h3>Recent runs</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Examined</th>
                  <th>Staged</th>
                  <th>Known</th>
                  <th>Excluded</th>
                  <th>Low match</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="small muted">{formatDate(run.startedAt)}</td>
                    <td className="small">{run.kind}</td>
                    <td>
                      <span className={`badge ${run.status === 'FAILED' ? 'danger' : run.status === 'SUCCEEDED' ? 'ok' : 'warn'}`}>
                        {run.status}
                      </span>
                      {run.error ? <div className="small muted">{run.error.slice(0, 90)}</div> : null}
                    </td>
                    <td>{run.itemsFetched}</td>
                    <td>{run.candidatesCreated}</td>
                    <td>{run.duplicatesSkipped}</td>
                    <td>{run.excludedByGeography}</td>
                    <td>{run.belowMatchThreshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <h2>Candidates</h2>

      <form method="get" className="card row">
        <div style={{ flex: '1 1 150px' }}>
          <label htmlFor="statusFilter">Status</label>
          <select id="statusFilter" name="status" defaultValue={params.status ?? 'NEW'}>
            <option value="NEW">Awaiting review</option>
            <option value="PROMOTED">Promoted</option>
            <option value="REJECTED">Rejected</option>
            <option value="DUPLICATE">Already known</option>
          </select>
        </div>
        <div style={{ flex: '0 1 130px' }}>
          <label htmlFor="minScore">Min match</label>
          <input id="minScore" name="minScore" type="number" min={0} max={100} defaultValue={params.minScore ?? ''} />
        </div>
        <div style={{ flex: '0 1 150px' }}>
          <label htmlFor="hasEmail">Has published email</label>
          <select id="hasEmail" name="hasEmail" defaultValue={params.hasEmail ?? ''}>
            <option value="">Any</option>
            <option value="1">Yes</option>
          </select>
        </div>
        <div style={{ flex: '0 1 150px' }}>
          <label htmlFor="hasFunding">Funding signal</label>
          <select id="hasFunding" name="hasFunding" defaultValue={params.hasFunding ?? ''}>
            <option value="">Any</option>
            <option value="1">Yes</option>
          </select>
        </div>
        <button type="submit" className="primary">
          Filter
        </button>
      </form>

      {candidates.items.length === 0 ? (
        <Empty>No candidates match. Run a source to find some.</Empty>
      ) : (
        candidates.items.map((candidate) => {
          const contactability =
            CONTACTABILITY_LABEL[candidate.contactability] ?? CONTACTABILITY_LABEL.UNKNOWN;
          const needsAcknowledgement = candidate.contactability === 'CONSENT_REQUIRED';

          return (
            <div className="card" key={candidate.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong>{candidate.companyName}</strong>{' '}
                  <span className="badge">{candidate.matchScore}/100 match</span>{' '}
                  <span className={`badge ${contactability?.className ?? ''}`}>
                    {contactability?.text}
                  </span>
                  <div className="small muted">
                    {candidate.locationText ?? 'Location unknown'} · via {candidate.source} ·{' '}
                    <SafeLink href={candidate.sourceUrl}>source</SafeLink>
                    {candidate.website ? (
                      <>
                        {' · '}
                        <SafeLink href={candidate.website}>website</SafeLink>
                      </>
                    ) : null}
                  </div>
                </div>
                {candidate.status !== 'NEW' ? (
                  <span className="badge">{candidate.status}</span>
                ) : null}
              </div>

              {candidate.description ? (
                <p className="small" style={{ marginBottom: 6 }}>
                  {candidate.description.slice(0, 400)}
                </p>
              ) : null}

              <div className="small muted" style={{ marginBottom: 8 }}>
                {candidate.technologyStack.length > 0 ? (
                  <div>Stack: {candidate.technologyStack.join(', ')}</div>
                ) : null}
                {candidate.fundingSignals.length > 0 ? (
                  <div>Funding: {candidate.fundingSignals.join('; ')}</div>
                ) : null}
                {candidate.hiringSignals.length > 0 ? (
                  <div>Hiring: {candidate.hiringSignals.join('; ')}</div>
                ) : null}
                <div>Why it matched: {candidate.matchReasons.join(' · ')}</div>
              </div>

              {candidate.status === 'NEW' ? (
                <>
                  {needsAcknowledgement ? (
                    <div className="notice error small">
                      This company is in a consent-based jurisdiction (GDPR/PECR or CASL). Cold
                      email there generally requires a lawful basis or prior consent, which is a
                      different legal footing from the US. Only tick the box below if you have
                      taken advice.
                    </div>
                  ) : null}

                  <form action={`/api/discovery/candidates/${candidate.id}/promote`} method="post" className="row">
                    <Csrf token={csrf} />
                    <div style={{ flex: '2 1 240px' }}>
                      <label htmlFor={`email-${candidate.id}`}>Contact email</label>
                      <input
                        id={`email-${candidate.id}`}
                        name="contactEmail"
                        type="email"
                        defaultValue={candidate.publishedEmail ?? ''}
                        placeholder={candidate.publishedEmail ? '' : 'No published address — find one'}
                        maxLength={254}
                        required
                      />
                    </div>
                    <div style={{ flex: '1 1 160px' }}>
                      <label htmlFor={`name-${candidate.id}`}>Contact name</label>
                      <input
                        id={`name-${candidate.id}`}
                        name="contactName"
                        defaultValue={candidate.contactName ?? ''}
                        maxLength={200}
                      />
                    </div>
                    <div style={{ flex: '1 1 150px' }}>
                      <label htmlFor={`role-${candidate.id}`}>Role</label>
                      <input
                        id={`role-${candidate.id}`}
                        name="contactRole"
                        defaultValue={candidate.contactRole ?? ''}
                        maxLength={200}
                      />
                    </div>
                    {needsAcknowledgement ? (
                      <label className="small" style={{ flex: '1 1 100%' }}>
                        <input type="checkbox" name="acknowledgedConsentRisk" value="1" style={{ width: 'auto' }} />{' '}
                        I have a lawful basis for contacting this company.
                      </label>
                    ) : null}
                    <button type="submit" className="primary">
                      Promote to prospect
                    </button>
                  </form>

                  <form action={`/api/discovery/candidates/${candidate.id}/reject`} method="post" className="row" style={{ marginTop: 8 }}>
                    <Csrf token={csrf} />
                    <input name="note" placeholder="Why not a fit?" maxLength={300} style={{ width: 260 }} />
                    <button type="submit">Reject</button>
                  </form>
                </>
              ) : candidate.promotedProspectId ? (
                <Link href={`/prospects/${candidate.promotedProspectId}`}>Open prospect</Link>
              ) : candidate.reviewNote ? (
                <p className="small muted">{candidate.reviewNote}</p>
              ) : null}
            </div>
          );
        })
      )}

      {candidates.totalPages > 1 ? (
        <p className="small muted">
          Page {candidates.page} of {candidates.totalPages} · {candidates.total} total
        </p>
      ) : null}
    </>
  );
}
