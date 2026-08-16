import { formAction, field } from '../../../../_components/handler.js';
import { editDraft } from '../../../../../src/services/drafts.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-2) as string;

  const result = await editDraft(user.id, id, {
    ...(field(form, 'subject') ? { subject: field(form, 'subject') as string } : {}),
    ...(form.get('bodyText') !== null ? { bodyText: String(form.get('bodyText')) } : {}),
  });

  if (!result.ok) return { redirect: `/review?message=${id}`, error: result.error ?? 'Could not save.' };

  return {
    redirect: `/review?message=${id}`,
    ok: result.approvalRevoked
      ? 'Draft saved. The previous approval was revoked — approve again before this can send.'
      : 'Draft saved.',
  };
});
