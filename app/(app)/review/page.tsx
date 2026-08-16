/**
 * Review queue — the mandatory human approval gate (brief §20, §21).
 *
 * Shows everything §20 requires before a decision: company, contact, role,
 * score with reasons, research with sources, the selected service, the exact
 * subject and body, and the scheduled send time.
 */
import Link from 'next/link';
import { requireUser } from '../../../src/lib/session.js';
import { getCsrfToken } from '../../../src/lib/csrf.js';
import { getMessage, getReviewQueue } from '../../../src/services/drafts.js';
import { getResearch } from '../../../src/services/research.js';
import { getScoreHistory } from '../../../src/services/qualification.js';
import { roleCategoryLabel } from '../../../src/domain/roles.js';
import type { QualificationReason } from '../../../src/domain/qualification.js';
import {
  Csrf,
  Empty,
  Notice,
  SafeLink,
  ScoreBadge,
  formatDate,
} from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const csrf = await getCsrfToken();

  const queue = await getReviewQueue(user.id, 50);
  const selectedId = params.message ?? queue[0]?.message.id;
  const selected = selectedId ? await getMessage(user.id, selectedId) : null;

  const research = selected ? await getResearch(user.id, selected.prospect.id) : null;
  const scores = selected ? await getScoreHistory(selected.prospect.id, 1) : [];
  const reasons = (scores[0]?.reasons ?? []) as QualificationReason[];

  return (
    <>
      <h1>Review queue</h1>
      <p className="muted small">
        {queue.length} message{queue.length === 1 ? '' : 's'} awaiting your approval. Nothing is sent
        without it, and any edit after approval requires approving again.
      </p>

      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      {params.ok ? <Notice kind="ok">{params.ok}</Notice> : null}

      {queue.length === 0 ? (
        <Empty>Nothing is waiting for approval.</Empty>
      ) : (
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <div style={{ flex: '0 0 250px' }}>
            {queue.map(({ message, company, contact, prospect }) => (
              <Link
                key={message.id}
                href={`/review?message=${message.id}`}
                className="cardlet"
                style={{
                  display: 'block',
                  textDecoration: 'none',
                  color: 'inherit',
                  borderColor: message.id === selectedId ? 'var(--accent)' : undefined,
                }}
              >
                <strong>{company.name}</strong>
                <div className="small muted">{contact.fullName}</div>
                <div className="small muted">
                  Score {prospect.qualificationScore ?? '—'} · {message.subject.slice(0, 42)}
                </div>
              </Link>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {!selected ? (
              <Empty>Select a message.</Empty>
            ) : (
              <>
                <div className="card">
                  <div className="grid">
                    <div>
                      <div className="label">Company</div>
                      <Link href={`/prospects/${selected.prospect.id}`}>{selected.company.name}</Link>
                    </div>
                    <div>
                      <div className="label">Contact</div>
                      {selected.contact.fullName}
                    </div>
                    <div>
                      <div className="label">Role</div>
                      {selected.contact.role ?? '—'} ({roleCategoryLabel(selected.contact.roleCategory)})
                    </div>
                    <div>
                      <div className="label">Recipient</div>
                      <span className="mono">{selected.message.toEmail}</span>
                    </div>
                    <div>
                      <div className="label">Qualification</div>
                      <ScoreBadge
                        score={selected.prospect.qualificationScore}
                        band={selected.prospect.qualificationBand}
                      />
                    </div>
                    <div>
                      <div className="label">Scheduled</div>
                      {selected.message.scheduledAt
                        ? formatDate(selected.message.scheduledAt)
                        : 'Next available window'}
                    </div>
                  </div>
                </div>

                <h3>Qualification reasons</h3>
                {reasons.length === 0 ? (
                  <Empty>Not scored yet.</Empty>
                ) : (
                  <ul className="small">
                    {reasons
                      .filter((r) => r.points > 0)
                      .map((r) => (
                        <li key={r.code}>
                          {r.label} (+{r.points})
                        </li>
                      ))}
                    {reasons.filter((r) => r.value === 'UNKNOWN').length > 0 ? (
                      <li className="muted">
                        Unknown:{' '}
                        {reasons
                          .filter((r) => r.value === 'UNKNOWN')
                          .map((r) => r.label)
                          .join(', ')}
                      </li>
                    ) : null}
                  </ul>
                )}

                <h3>Research and sources</h3>
                {!research ? (
                  <Empty>No research recorded.</Empty>
                ) : (
                  <div className="card small">
                    <p>
                      <strong>Pain point:</strong> {research.research.potentialPainPoint ?? '—'}
                    </p>
                    <p>
                      <strong>Why relevant:</strong> {research.research.whyRelevant ?? '—'}
                    </p>
                    <p>
                      <strong>Why now:</strong> {research.research.reasonForReachingOutNow ?? '—'}
                    </p>
                    <div>
                      <strong>Sources:</strong>{' '}
                      {research.sources.length === 0 ? (
                        <span className="muted">none recorded — treat claims as unverified</span>
                      ) : (
                        research.sources.map((s) => (
                          <span key={s.id} style={{ marginRight: 10 }}>
                            <SafeLink href={s.url}>{s.title ?? s.field}</SafeLink>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                )}

                <h3>Email</h3>
                <form action={`/api/drafts/${selected.message.id}/edit`} method="post" className="card">
                  <Csrf token={csrf} />
                  <div className="field">
                    <label htmlFor="subject">Subject</label>
                    <input id="subject" name="subject" defaultValue={selected.message.subject} maxLength={500} />
                  </div>
                  <div className="field">
                    <label htmlFor="bodyText">Body</label>
                    <textarea
                      id="bodyText"
                      name="bodyText"
                      defaultValue={selected.message.bodyText}
                      style={{ minHeight: 320, fontFamily: 'var(--mono)', fontSize: 13 }}
                    />
                  </div>
                  <button type="submit">Save draft (requires re-approval)</button>
                </form>

                <div className="row">
                  <form action={`/api/drafts/${selected.message.id}/approve`} method="post">
                    <Csrf token={csrf} />
                    <input type="hidden" name="contentHash" value={selected.message.contentHash} />
                    <button type="submit" className="primary">
                      Approve for sending
                    </button>
                  </form>

                  <form action={`/api/drafts/${selected.message.id}/reject`} method="post" className="row">
                    <Csrf token={csrf} />
                    <input name="reason" placeholder="Reason" required maxLength={300} style={{ width: 200 }} />
                    <button type="submit">Reject</button>
                  </form>

                  <form action={`/api/prospects/${selected.prospect.id}/status`} method="post">
                    <Csrf token={csrf} />
                    <input type="hidden" name="status" value="DO_NOT_CONTACT" />
                    <input type="hidden" name="reason" value="Marked do-not-contact from the review queue." />
                    <input type="hidden" name="suppress" value="1" />
                    <button type="submit" className="danger">
                      Do not contact
                    </button>
                  </form>
                </div>

                <p className="small muted" style={{ marginTop: 10 }}>
                  Approval is bound to a hash of this exact content. Editing after approval revokes
                  it automatically.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
