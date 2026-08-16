import { formAction, field, intField, requiredField, ValidationError } from '../../_components/handler.js';
import { createCampaign } from '../../../src/services/campaigns.js';
import { parseTimeOfDay } from '../../../src/domain/timezone.js';

/** "09:00-11:30, 13:00-16:30" → [{start,end}] */
function parseWindows(raw: string): { start: string; end: string }[] {
  const windows: { start: string; end: string }[] = [];
  for (const part of raw.split(',')) {
    const [start, end] = part.split('-').map((s) => s.trim());
    if (!start || !end) continue;
    if (parseTimeOfDay(start) === null || parseTimeOfDay(end) === null) {
      throw new ValidationError(`"${part.trim()}" is not a valid window (use HH:MM-HH:MM).`);
    }
    windows.push({ start, end });
  }
  if (windows.length === 0) throw new ValidationError('At least one sending window is required.');
  return windows;
}

export const POST = formAction(async ({ user, form }) => {
  const steps: { delayDays: number; templateId: string }[] = [];
  for (let i = 0; i < 4; i += 1) {
    const templateId = field(form, `template${i}`);
    if (!templateId) continue;
    steps.push({ delayDays: intField(form, `delay${i}`) ?? 0, templateId });
  }
  if (steps.length === 0) throw new ValidationError('A campaign needs at least one step.');

  const result = await createCampaign({
    userId: user.id,
    name: requiredField(form, 'name'),
    description: field(form, 'description') ?? '',
    timezone: requiredField(form, 'timezone'),
    sendingWindows: parseWindows(requiredField(form, 'windows')),
    sendDays: (field(form, 'sendDays') ?? '1,2,3,4,5')
      .split(',')
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isInteger(d)),
    steps,
  });

  if (!result.ok) return { redirect: '/campaigns', error: result.error };
  return { redirect: '/campaigns', ok: `Campaign "${result.campaign.name}" created as a draft.` };
});
