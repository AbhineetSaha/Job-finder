import { formAction, field, requiredField } from '../../_components/handler.js';
import { createProspect } from '../../../src/services/prospects.js';

export const POST = formAction(async ({ user, form }) => {
  const result = await createProspect({
    userId: user.id,
    source: 'MANUAL',
    companyName: requiredField(form, 'companyName'),
    website: field(form, 'website'),
    contactName: field(form, 'contactName'),
    contactRole: field(form, 'contactRole'),
    contactEmail: requiredField(form, 'contactEmail'),
    contactReason: field(form, 'contactReason'),
    sourceUrl: field(form, 'sourceUrl'),
    industry: field(form, 'industry'),
    state: field(form, 'state'),
    timezone: field(form, 'timezone'),
    notes: field(form, 'notes'),
  });

  if (!result.ok) {
    return result.duplicateOf?.prospectId
      ? { redirect: `/prospects/${result.duplicateOf.prospectId}`, error: result.error }
      : { redirect: '/prospects/new', error: result.error };
  }

  return { redirect: `/prospects/${result.prospect.id}`, ok: 'Prospect created.' };
});
