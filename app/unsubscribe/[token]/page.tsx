/**
 * One-click unsubscribe.
 *
 * Deliberately requires no login, no confirmation step, and no explanation
 * form: honouring the request must be the path of least resistance. The
 * suppression, the sequence stop, and the status change all commit before this
 * page renders.
 */
import { processUnsubscribe } from '../../../src/services/events.js';
import { sha256 } from '../../../src/lib/crypto.js';

export const dynamic = 'force-dynamic';

export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await processUnsubscribe(sha256(token));

  return (
    <main style={{ maxWidth: 520, margin: '80px auto', padding: '0 20px' }}>
      {result.ok ? (
        <>
          <h1>You&apos;ve been unsubscribed</h1>
          <p>
            {result.alreadyDone
              ? 'You were already unsubscribed. Nothing further will be sent.'
              : 'You will not receive any further emails. Any scheduled follow-ups have been cancelled.'}
          </p>
          <p className="muted small">
            This is permanent and cannot be undone by the sender. You can close this page.
          </p>
        </>
      ) : (
        <>
          <h1>This link is not valid</h1>
          <p className="muted">
            {result.error ?? 'The unsubscribe link could not be recognised.'}
          </p>
          <p className="small">
            If you are still receiving mail you did not ask for, reply to any message and ask to be
            removed.
          </p>
        </>
      )}
    </main>
  );
}
