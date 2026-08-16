import { formAction, field } from '../../../_components/handler.js';
import { updateProfile } from '../../../../src/services/users.js';
import { safeUrl } from '../../../../src/domain/normalize.js';

export const POST = formAction(async ({ user, form }) => {
  await updateProfile(user.id, {
    name: field(form, 'name') ?? '',
    title: field(form, 'title') ?? '',
    bio: field(form, 'bio') ?? '',
    email: field(form, 'email') ?? '',
    availability: field(form, 'availability') ?? '',
    portfolioUrl: safeUrl(field(form, 'portfolioUrl')),
    hourlyRate: field(form, 'hourlyRate'),
    minimumProjectValue: field(form, 'minimumProjectValue'),
  });

  return { redirect: '/settings', ok: 'Profile saved.' };
});
