import { formAction, requiredField } from '../../../../_components/handler.js';
import { classifyReply, type ReplyClassification } from '../../../../../src/services/events.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-2) as string;
  const classification = requiredField(form, 'classification') as ReplyClassification;

  const result = await classifyReply(user.id, id, classification);
  if (!result.ok) return { redirect: '/conversations', error: result.error ?? 'Could not classify.' };

  return { redirect: '/conversations', ok: `Reply classified as ${classification.replace(/_/g, ' ')}.` };
});
