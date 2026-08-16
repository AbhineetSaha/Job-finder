/** Dashboard: "what needs my attention today?" (brief §48). */
import Link from 'next/link';
import { requireUser } from '../../src/lib/session.js';
import { getDashboardCounts, listUpcomingMeetings } from '../../src/services/crm.js';
import { getReviewQueue } from '../../src/services/drafts.js';
import { listUnreadReplies } from '../../src/services/events.js';
import { listProspects } from '../../src/services/prospects.js';
import { Empty, ScoreBadge, Stat, formatDate, money } from '../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const user = await requireUser();

  const [counts, queue, replies, meetings, needsResearch] = await Promise.all([
    getDashboardCounts(user.id),
    getReviewQueue(user.id, 5),
    listUnreadReplies(user.id, 5),
    listUpcomingMeetings(user.id, 5),
    listProspects(user.id, { status: ['DISCOVERED', 'RESEARCHING'] }, 1, 5),
  ]);

  return (
    <>
      <h1>Today</h1>
      <p className="muted">What needs your attention.</p>

      <div className="grid" style={{ marginTop: 16 }}>
        <Stat label="Awaiting research" value={counts.awaitingResearch} href="/prospects?status=DISCOVERED" />
        <Stat label="Awaiting approval" value={counts.awaitingApproval} href="/review" />
        <Stat label="Scheduled to send" value={counts.scheduled} />
        <Stat label="Follow-ups due" value={counts.followUpsDue} />
        <Stat label="Unread replies" value={counts.unreadReplies} href="/conversations" />
        <Stat label="Upcoming meetings" value={counts.upcomingMeetings} />
        <Stat label="Open pipeline" value={money(counts.openPipelineValue)} href="/pipeline" />
      </div>

      <h2>Waiting for your approval</h2>
      {queue.length === 0 ? (
        <Empty>Nothing is waiting for approval.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Score</th>
                <th>Subject</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.map(({ message, company, contact, prospect }) => (
                <tr key={message.id}>
                  <td>{company.name}</td>
                  <td>
                    {contact.fullName}
                    <div className="small muted">{contact.role ?? 'Role unknown'}</div>
                  </td>
                  <td>
                    <ScoreBadge score={prospect.qualificationScore} band={prospect.qualificationBand} />
                  </td>
                  <td>{message.subject}</td>
                  <td>
                    <Link href={`/review?message=${message.id}`}>Review</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Unread replies</h2>
      {replies.length === 0 ? (
        <Empty>No unread replies.</Empty>
      ) : (
        <ul>
          {replies.map(({ reply, contact, prospect }) => (
            <li key={reply.id}>
              <Link href={`/prospects/${prospect.id}`}>{contact.fullName}</Link>{' '}
              <span className="muted small">— {reply.subject ?? 'no subject'} · {formatDate(reply.receivedAt)}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Upcoming meetings</h2>
      {meetings.length === 0 ? (
        <Empty>No meetings scheduled.</Empty>
      ) : (
        <ul>
          {meetings.map(({ meeting, company, contact }) => (
            <li key={meeting.id}>
              {formatDate(meeting.scheduledFor)} — {contact.fullName} at {company.name}
            </li>
          ))}
        </ul>
      )}

      <h2>Needs research</h2>
      {needsResearch.items.length === 0 ? (
        <Empty>Every prospect has been researched.</Empty>
      ) : (
        <ul>
          {needsResearch.items.map(({ prospect, company, contact }) => (
            <li key={prospect.id}>
              <Link href={`/prospects/${prospect.id}`}>{company.name}</Link>{' '}
              <span className="muted small">— {contact.fullName}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
