import { eq } from 'drizzle-orm';
import { formAction, field, requiredField } from '../../../_components/handler.js';
import { getDb } from '../../../../src/db/client.js';
import { settings } from '../../../../src/db/schema.js';
import { recordAudit } from '../../../../src/services/audit.js';
import { ensureSettings } from '../../../../src/services/config.js';

export const POST = formAction(async ({ user, form }) => {
  await ensureSettings(user.id);

  await getDb()
    .update(settings)
    .set({
      postalAddress: requiredField(form, 'postalAddress').slice(0, 500),
      advertisingDisclosure: (field(form, 'advertisingDisclosure') ?? '').slice(0, 300),
      updatedAt: new Date(),
    })
    .where(eq(settings.userId, user.id));

  await recordAudit({
    userId: user.id,
    action: 'SETTINGS_UPDATED',
    entityType: 'settings',
    entityId: user.id,
    metadata: { section: 'compliance' },
  });

  return { redirect: '/settings', ok: 'Compliance details saved.' };
});
