import { formAction } from '../../../_components/handler.js';
import { qualifyProspect } from '../../../../src/services/qualification.js';
import { SIGNAL_KEYS } from '../../../../src/domain/qualification.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-1) as string;

  const signals: Record<string, unknown> = {};
  for (const key of SIGNAL_KEYS) signals[key] = form.get(key);

  const result = await qualifyProspect(user.id, id, signals);
  if (!result.ok) return { redirect: `/prospects/${id}`, error: result.error };

  return {
    redirect: `/prospects/${id}`,
    ok: `Scored ${result.result.score}/100 — ${result.result.band.replace(/_/g, ' ').toLowerCase()}.`,
  };
});
