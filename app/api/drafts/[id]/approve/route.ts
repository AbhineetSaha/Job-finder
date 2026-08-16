import { formAction, field } from '../../../../_components/handler.js';
import { approveDraft } from '../../../../../src/services/drafts.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-2) as string;
  // The hash the reviewer actually saw. If the message changed since the page
  // was rendered, the approval is refused rather than applied to unread content.
  const expected = field(form, 'contentHash');

  const result = await approveDraft(user.id, id, user.id, expected ?? undefined);
  if (!result.ok) return { redirect: `/review?message=${id}`, error: result.error ?? 'Could not approve.' };

  return {
    redirect: '/review',
    ok: `Approved (version ${result.approvalVersion}). It will send in the next valid window.`,
  };
});
