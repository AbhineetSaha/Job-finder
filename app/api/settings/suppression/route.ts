import { formAction, requiredField } from '../../../_components/handler.js';
import { addSuppression, type SuppressionReason } from '../../../../src/services/suppression.js';
import { normalizeEmail } from '../../../../src/domain/normalize.js';

export const POST = formAction(async ({ user, form }) => {
  const target = requiredField(form, 'target');
  const reason = (requiredField(form, 'reason') as SuppressionReason) ?? 'MANUAL_BLOCK';

  // A value that parses as an email suppresses that address; anything else is
  // treated as a whole-domain block.
  const asEmail = normalizeEmail(target);

  await addSuppression({
    userId: user.id,
    ...(asEmail ? { email: target } : { domain: target }),
    reason,
    note: 'Added from Settings.',
    createdBy: user.id,
  });

  return { redirect: '/settings', ok: `${target} suppressed.` };
});
