import { formAction, field } from '../../../../../_components/handler.js';
import { rejectCandidate } from '../../../../../../src/services/discovery.js';

export const POST = formAction(async ({ user, form, request }) => {
  const candidateId = request.nextUrl.pathname.split('/').at(-2) as string;
  const result = await rejectCandidate(user.id, candidateId, field(form, 'note') ?? 'Not a fit.');

  return result.ok
    ? { redirect: '/discovery', ok: 'Candidate rejected.' }
    : { redirect: '/discovery', error: result.error ?? 'Could not reject.' };
});
