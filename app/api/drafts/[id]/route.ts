import { formAction, field, requiredField } from '../../../_components/handler.js';
import { createDraft } from '../../../../src/services/drafts.js';

export const POST = formAction(async ({ user, form, request }) => {
  const prospectId = request.nextUrl.pathname.split('/').at(-1) as string;

  const result = await createDraft({
    userId: user.id,
    prospectId,
    templateId: requiredField(form, 'templateId'),
    serviceId: field(form, 'serviceId'),
    personalization: {
      specificObservation: field(form, 'specificObservation'),
      engineeringSignal: field(form, 'engineeringSignal'),
      painPoint: field(form, 'painPoint'),
      whyRelevant: field(form, 'whyRelevant'),
      specificOffer: field(form, 'specificOffer'),
      relevantTechnology: field(form, 'relevantTechnology'),
    },
  });

  if (!result.ok) return { redirect: `/prospects/${prospectId}`, error: result.error };

  return { redirect: `/review?message=${result.message.id}`, ok: 'Draft created — review and approve it.' };
});
