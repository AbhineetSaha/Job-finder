import { formAction, field, requiredField } from '../../../../../_components/handler.js';
import { promoteCandidate } from '../../../../../../src/services/discovery.js';

export const POST = formAction(async ({ user, form, request }) => {
  const candidateId = request.nextUrl.pathname.split('/').at(-2) as string;

  const result = await promoteCandidate({
    userId: user.id,
    candidateId,
    contactEmail: requiredField(form, 'contactEmail'),
    contactName: field(form, 'contactName'),
    contactRole: field(form, 'contactRole'),
    acknowledgedConsentRisk: field(form, 'acknowledgedConsentRisk') === '1',
  });

  if (!result.ok) return { redirect: '/discovery', error: result.error };

  return {
    redirect: `/prospects/${result.prospectId}`,
    ok: 'Promoted. Research this prospect before drafting anything.',
  };
});
