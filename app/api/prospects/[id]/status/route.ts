import { formAction, field, requiredField } from '../../../../_components/handler.js';
import { changeProspectStatus } from '../../../../../src/services/prospects.js';
import { stopSequence } from '../../../../../src/services/campaigns.js';
import { addSuppression } from '../../../../../src/services/suppression.js';
import { getProspect } from '../../../../../src/services/prospects.js';
import type { ProspectStatus } from '../../../../../src/domain/status.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-2) as string;
  const status = requiredField(form, 'status') as ProspectStatus;
  const reason = field(form, 'reason');

  const result = await changeProspectStatus(user.id, id, status, {
    ...(reason ? { reason } : {}),
  });

  if (!result.ok) return { redirect: `/prospects/${id}`, error: result.error ?? 'Could not change status.' };

  // These outcomes must also stop outreach, not merely relabel it.
  if (status === 'DO_NOT_CONTACT' || status === 'NOT_INTERESTED') {
    await stopSequence(user.id, id, status, reason ?? 'Set from the UI.');
  }

  if (status === 'DO_NOT_CONTACT' && field(form, 'suppress')) {
    const record = await getProspect(user.id, id);
    if (record) {
      await addSuppression({
        userId: user.id,
        email: record.contact.email,
        reason: 'DO_NOT_CONTACT',
        note: reason ?? 'Marked do-not-contact by the operator.',
        createdBy: user.id,
      });
    }
  }

  return { redirect: `/prospects/${id}`, ok: `Status changed to ${status.replace(/_/g, ' ')}.` };
});
