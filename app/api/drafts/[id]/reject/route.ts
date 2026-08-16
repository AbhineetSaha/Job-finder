import { formAction, requiredField } from '../../../../_components/handler.js';
import { rejectDraft } from '../../../../../src/services/drafts.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-2) as string;
  const result = await rejectDraft(user.id, id, requiredField(form, 'reason'));

  if (!result.ok) return { redirect: `/review?message=${id}`, error: result.error ?? 'Could not reject.' };
  return { redirect: '/review', ok: 'Draft rejected.' };
});
