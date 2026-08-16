/** Conversations: replies awaiting classification, and recent threads. */
import Link from 'next/link';
import { requireUser } from '../../../src/lib/session.js';
import { getCsrfToken } from '../../../src/lib/csrf.js';
import { listUnreadReplies } from '../../../src/services/events.js';
import { listProspects } from '../../../src/services/prospects.js';
import { Csrf, Empty, Notice, formatDate } from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

const CLASSIFICATIONS = ['POSITIVE', 'INTERESTED', 'QUESTION', 'NOT_INTERESTED', 'REFERRAL', 'OTHER'] as const;

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const csrf = await getCsrfToken();
  const params = await searchParams;

  const [unread, replied] = await Promise.all([
    listUnreadReplies(user.id, 50),
    listProspects(user.id, { status: ['REPLIED', 'MEETING_BOOKED', 'PROPOSAL_SENT', 'NEGOTIATION'] }, 1, 50),
  ]);

  return (
    <>
      <h1>Conversations</h1>
      <p className="muted small">
        Replies are classified by you. Nothing infers intent from the text.
      </p>

      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      {params.ok ? <Notice kind="ok">{params.ok}</Notice> : null}

      <h2>Unclassified replies</h2>
      {unread.length === 0 ? (
        <Empty>No unread replies.</Empty>
      ) : (
        unread.map(({ reply, contact, prospect }) => (
          <div className="card" key={reply.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{contact.fullName}</strong>{' '}
                <span className="muted small">&lt;{reply.fromEmail}&gt;</span>
                <div className="small muted">{formatDate(reply.receivedAt)}</div>
              </div>
              <Link href={`/prospects/${prospect.id}`}>Open prospect</Link>
            </div>
            <p style={{ marginBottom: 6 }}>
              <strong>{reply.subject ?? 'No subject'}</strong>
            </p>
            {reply.bodyText ? <pre className="email">{reply.bodyText}</pre> : null}

            <form action={`/api/replies/${reply.id}/classify`} method="post" className="row" style={{ marginTop: 10 }}>
              <Csrf token={csrf} />
              <select name="classification" required style={{ width: 200 }}>
                {CLASSIFICATIONS.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              <button type="submit" className="primary">
                Classify
              </button>
            </form>
          </div>
        ))
      )}

      <h2>Active conversations</h2>
      {replied.items.length === 0 ? (
        <Empty>No active conversations.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Last contacted</th>
              </tr>
            </thead>
            <tbody>
              {replied.items.map(({ prospect, company, contact }) => (
                <tr key={prospect.id}>
                  <td>
                    <Link href={`/prospects/${prospect.id}`}>{company.name}</Link>
                  </td>
                  <td>{contact.fullName}</td>
                  <td>{prospect.status.replace(/_/g, ' ')}</td>
                  <td className="small muted">{formatDate(prospect.lastContactedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
