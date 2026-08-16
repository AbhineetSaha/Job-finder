/** CRM pipeline board (brief §36). Transitions are explicit and recorded. */
import Link from 'next/link';
import { requireUser } from '../../../src/lib/session.js';
import { getPipeline } from '../../../src/services/crm.js';
import { PIPELINE_STAGES } from '../../../src/domain/status.js';
import { money } from '../../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const user = await requireUser();
  const board = await getPipeline(user.id);

  return (
    <>
      <h1>Pipeline</h1>
      <p className="muted small">
        Status changes go through the state machine and every transition is recorded on the
        prospect timeline.
      </p>

      <div className="board">
        {PIPELINE_STAGES.map((stage) => (
          <div className="col" key={stage}>
            <h3>
              {stage.replace(/_/g, ' ')} ({board[stage].length})
            </h3>
            {board[stage].map((card) => (
              <div className="cardlet" key={card.prospectId}>
                <Link href={`/prospects/${card.prospectId}`}>{card.companyName}</Link>
                <div className="small muted">{card.contactName}</div>
                <div className="small muted">
                  {card.score !== null ? `Score ${card.score}` : 'Not scored'}
                  {card.estimatedValue ? ` · ${money(card.estimatedValue)}` : ''}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
