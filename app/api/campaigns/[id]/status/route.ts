import { formAction, requiredField } from '../../../../_components/handler.js';
import { setCampaignStatus, type CampaignStatus } from '../../../../../src/services/campaigns.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-2) as string;
  const status = requiredField(form, 'status') as CampaignStatus;

  const result = await setCampaignStatus(user.id, id, status);
  if (!result.ok) return { redirect: '/campaigns', error: result.error ?? 'Could not change status.' };

  return { redirect: '/campaigns', ok: `Campaign is now ${status}.` };
});
