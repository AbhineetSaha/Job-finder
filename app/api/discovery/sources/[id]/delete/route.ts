import { formAction } from '../../../../../_components/handler.js';
import { deleteDiscoverySource } from '../../../../../../src/services/discovery.js';

export const POST = formAction(async ({ user, request }) => {
  const sourceId = request.nextUrl.pathname.split('/').at(-2) as string;
  const removed = await deleteDiscoverySource(user.id, sourceId);

  return removed
    ? { redirect: '/discovery', ok: 'Source removed. Candidates it found are kept.' }
    : { redirect: '/discovery', error: 'Source not found.' };
});
