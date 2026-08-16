import { formAction } from '../../../../../_components/handler.js';
import { enqueue } from '../../../../../../src/queue/queue.js';

export const POST = formAction(async ({ user, request }) => {
  const sourceId = request.nextUrl.pathname.split('/').at(-2) as string;

  // Runs happen in the worker: a source can be slow, and a page request should
  // not hold a connection open while a rate-limited API is politely polled.
  const job = await enqueue({
    kind: 'DISCOVERY_RUN',
    payload: { userId: user.id, sourceId },
    // One in-flight run per source; a second click is a no-op rather than a
    // second set of requests to someone else's API.
    dedupeKey: `discovery:${sourceId}:${new Date().toISOString().slice(0, 13)}`,
  });

  return {
    redirect: '/discovery',
    ok: job
      ? 'Discovery run queued. Results appear below as the worker processes it.'
      : 'A run for this source is already queued for this hour.',
  };
});
