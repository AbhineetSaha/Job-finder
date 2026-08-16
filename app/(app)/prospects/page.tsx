/** Prospect list. All filtering happens in SQL; results are paginated. */
import Link from 'next/link';
import { requireUser } from '../../../src/lib/session.js';
import { listProspects, type ProspectFilters } from '../../../src/services/prospects.js';
import { PROSPECT_STATUSES, type ProspectStatus } from '../../../src/domain/status.js';
import { Empty, ScoreBadge, StatusBadge, formatDate } from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  const filters: ProspectFilters = {
    ...(params.search ? { search: params.search } : {}),
    ...(params.status && PROSPECT_STATUSES.includes(params.status as ProspectStatus)
      ? { status: [params.status as ProspectStatus] }
      : {}),
    ...(params.minScore ? { minScore: Number(params.minScore) } : {}),
    ...(params.industry ? { industry: params.industry } : {}),
    sort: (params.sort as ProspectFilters['sort']) ?? 'score',
  };

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const result = await listProspects(user.id, filters, page, 25);

  const pageHref = (n: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== 'page') query.set(key, value);
    }
    query.set('page', String(n));
    return `/prospects?${query.toString()}`;
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Prospects</h1>
          <p className="muted small">{result.total} total</p>
        </div>
        <div className="row">
          <Link className="btn" href="/prospects/new">
            Add prospect
          </Link>
          <Link className="btn" href="/import">
            Import CSV
          </Link>
          <a className="btn" href="/api/export/prospects">
            Export CSV
          </a>
        </div>
      </div>

      <form method="get" className="card row" style={{ marginTop: 16 }}>
        <div style={{ flex: '2 1 220px' }}>
          <label htmlFor="search">Search</label>
          <input
            id="search"
            name="search"
            defaultValue={params.search ?? ''}
            placeholder="Company, domain, contact, email"
          />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={params.status ?? ''}>
            <option value="">Any</option>
            {PROSPECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '0 1 120px' }}>
          <label htmlFor="minScore">Min score</label>
          <input
            id="minScore"
            name="minScore"
            type="number"
            min={0}
            max={100}
            defaultValue={params.minScore ?? ''}
          />
        </div>
        <div style={{ flex: '0 1 150px' }}>
          <label htmlFor="sort">Sort</label>
          <select id="sort" name="sort" defaultValue={params.sort ?? 'score'}>
            <option value="score">Score</option>
            <option value="created">Newest</option>
            <option value="updated">Recently updated</option>
            <option value="company">Company name</option>
          </select>
        </div>
        <button type="submit" className="primary">
          Filter
        </button>
      </form>

      {result.items.length === 0 ? (
        <Empty>No prospects match. Import a CSV or add one manually to begin.</Empty>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Score</th>
                  <th>Status</th>
                  <th>Last contacted</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map(({ prospect, company, contact }) => (
                  <tr key={prospect.id}>
                    <td>
                      <Link href={`/prospects/${prospect.id}`}>{company.name}</Link>
                      <div className="small muted">
                        {company.normalizedDomain ?? 'no domain'} · {company.city ?? '—'}
                        {company.state ? `, ${company.state}` : ''}
                      </div>
                    </td>
                    <td>
                      {contact.fullName}
                      <div className="small muted">{contact.role ?? 'Role unknown'}</div>
                    </td>
                    <td>
                      <ScoreBadge
                        score={prospect.qualificationScore}
                        band={prospect.qualificationBand}
                      />
                    </td>
                    <td>
                      <StatusBadge status={prospect.status} />
                    </td>
                    <td className="small muted">{formatDate(prospect.lastContactedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.totalPages > 1 ? (
            <div className="row" style={{ marginTop: 12 }}>
              {page > 1 ? (
                <Link className="btn" href={pageHref(page - 1)}>
                  Previous
                </Link>
              ) : null}
              <span className="muted small">
                Page {result.page} of {result.totalPages}
              </span>
              {page < result.totalPages ? (
                <Link className="btn" href={pageHref(page + 1)}>
                  Next
                </Link>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
