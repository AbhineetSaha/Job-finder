/**
 * Analytics. Volume metrics are recorded but demoted; the numbers that decide
 * whether the outreach is working come first (brief §39).
 */
import { requireUser } from '../../../src/lib/session.js';
import { getAnalytics, getCampaignPerformance } from '../../../src/services/analytics.js';
import { Empty, Stat, money } from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const user = await requireUser();
  const [a, campaigns] = await Promise.all([
    getAnalytics(user.id),
    getCampaignPerformance(user.id),
  ]);

  return (
    <>
      <h1>Analytics</h1>

      <h2>Business outcomes</h2>
      <p className="muted small">
        These are the numbers that matter. A campaign that sends a lot and books nothing is a
        failed campaign.
      </p>
      <div className="grid">
        <Stat label="Positive replies" value={a.outreach.positiveReplies} />
        <Stat label="Meetings booked" value={a.outreach.meetings} />
        <Stat label="Proposals sent" value={a.sales.proposals} />
        <Stat label="Contracts won" value={a.sales.won} />
        <Stat label="Revenue" value={money(a.sales.revenue)} />
        <Stat label="Expected revenue" value={money(a.sales.expectedRevenue)} />
        <Stat label="Average deal size" value={money(a.sales.averageDealSize)} />
        <Stat label="Revenue per prospect" value={money(a.conversion.revenuePerProspect)} />
      </div>

      <h2>Conversion</h2>
      <div className="grid">
        <Stat label="Qualification rate" value={`${a.conversion.qualificationRate}%`} />
        <Stat label="Approval rate" value={`${a.conversion.approvalRate}%`} />
        <Stat label="Delivery rate" value={`${a.conversion.deliveryRate}%`} />
        <Stat label="Reply rate" value={`${a.conversion.replyRate}%`} />
        <Stat label="Positive reply rate" value={`${a.conversion.positiveReplyRate}%`} />
        <Stat label="Meeting rate" value={`${a.conversion.meetingRate}%`} />
        <Stat label="Proposal rate" value={`${a.conversion.proposalRate}%`} />
        <Stat label="Close rate" value={`${a.conversion.closeRate}%`} />
      </div>

      <h2>Prospects</h2>
      <div className="grid">
        <Stat label="Total" value={a.prospects.total} />
        <Stat label="Qualified (60+)" value={a.prospects.qualified} />
        <Stat label="High priority (90+)" value={a.prospects.highPriority} />
        <Stat label="Contacted" value={a.prospects.contacted} />
      </div>

      <h2>Volume</h2>
      <div className="grid">
        <Stat label="Sent" value={a.outreach.sent} />
        <Stat label="Delivered" value={a.outreach.delivered} />
        <Stat label="Bounced" value={a.outreach.bounced} />
        <Stat label="Blocked by safety checks" value={a.outreach.blocked} />
        <Stat label="Failed" value={a.outreach.failed} />
        <Stat label="Replies" value={a.outreach.replies} />
      </div>

      <h2>By campaign</h2>
      <p className="muted small">
        Compare campaigns yourself; nothing here optimises automatically (brief §40).
      </p>
      {campaigns.length === 0 ? (
        <Empty>No campaigns yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Enrolled</th>
                <th>Sent</th>
                <th>Replies</th>
                <th>Positive</th>
                <th>Meetings</th>
                <th>Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.campaignId}>
                  <td>{c.name}</td>
                  <td>{c.status}</td>
                  <td>{c.enrolled}</td>
                  <td>{c.sent}</td>
                  <td>{c.replies}</td>
                  <td>{c.positiveReplies}</td>
                  <td>{c.meetings}</td>
                  <td>{c.replyRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
