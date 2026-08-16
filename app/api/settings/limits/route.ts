import { eq } from 'drizzle-orm';
import { formAction, field, intField, ValidationError } from '../../../_components/handler.js';
import { getDb } from '../../../../src/db/client.js';
import { settings } from '../../../../src/db/schema.js';
import { recordAudit } from '../../../../src/services/audit.js';
import { ensureSettings } from '../../../../src/services/config.js';
import { isValidTimeZone } from '../../../../src/domain/timezone.js';

/** Clamp rather than merely validate, so a hostile value cannot widen a limit. */
function clamp(value: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return Math.max(min, Math.min(max, value));
}

export const POST = formAction(async ({ user, form }) => {
  await ensureSettings(user.id);

  const min = clamp(intField(form, 'minDelaySeconds'), 0, 86_400);
  const max = clamp(intField(form, 'maxDelaySeconds'), 0, 86_400);
  if (min !== null && max !== null && min > max) {
    throw new ValidationError('Minimum spacing cannot exceed maximum spacing.');
  }

  const timezone = field(form, 'defaultTimezone');
  if (timezone && !isValidTimeZone(timezone)) {
    throw new ValidationError('That is not a valid IANA time zone.');
  }

  await getDb()
    .update(settings)
    .set({
      dailySendLimit: clamp(intField(form, 'dailySendLimit'), 0, 2000),
      hourlySendLimit: clamp(intField(form, 'hourlySendLimit'), 0, 500),
      perDomainDailyLimit: clamp(intField(form, 'perDomainDailyLimit'), 0, 500),
      minDelaySeconds: min,
      maxDelaySeconds: max,
      defaultTimezone: timezone,
      updatedAt: new Date(),
    })
    .where(eq(settings.userId, user.id));

  await recordAudit({
    userId: user.id,
    action: 'SETTINGS_UPDATED',
    entityType: 'settings',
    entityId: user.id,
    metadata: { section: 'limits' },
  });

  return { redirect: '/settings', ok: 'Sending limits saved.' };
});
