import { formAction, field } from '../../../_components/handler.js';
import { setGlobalPause } from '../../../../src/services/ops.js';

export const POST = formAction(async ({ user, form }) => {
  const paused = field(form, 'paused') === '1';
  const reason = field(form, 'reason') ?? (paused ? 'Paused from the UI.' : 'Resumed from the UI.');

  const result = await setGlobalPause(user.id, paused, reason);

  return {
    redirect: '/settings',
    ok: paused
      ? `All sending paused. ${result.campaignsPaused ?? 0} running campaign(s) were also paused; restart each one deliberately when you resume.`
      : 'Sending resumed. Restart each campaign you want running again.',
  };
});
