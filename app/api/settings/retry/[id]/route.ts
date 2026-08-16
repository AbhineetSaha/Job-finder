import { formAction } from '../../../../_components/handler.js';
import { retryFailedMessage } from '../../../../../src/services/ops.js';

export const POST = formAction(async ({ user, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-1) as string;

  const result = await retryFailedMessage(user.id, id);
  if (!result.ok) return { redirect: '/settings', error: result.error ?? 'Could not retry.' };

  return {
    redirect: '/settings',
    ok: 'Message re-queued. It will pass the full safety preflight again before sending.',
  };
});
