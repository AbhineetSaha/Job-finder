import { formAction, requiredField, ValidationError } from '../../../_components/handler.js';
import { MAX_CSV_BYTES, parseImportCsv } from '../../../../src/domain/csv.js';
import { importProspects } from '../../../../src/services/prospects.js';

export const POST = formAction(async ({ user, form }) => {
  const csv = requiredField(form, 'csv');

  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    throw new ValidationError('That file is too large. The limit is 5 MB.');
  }

  // Re-parsed server-side: the browser preview is a convenience, not a trust
  // boundary, so nothing the client computed is taken on faith.
  const parsed = parseImportCsv(csv);

  if (parsed.missingColumns.length > 0) {
    throw new ValidationError(`Missing required column(s): ${parsed.missingColumns.join(', ')}.`);
  }
  if (parsed.valid.length === 0) {
    throw new ValidationError('No valid rows to import.');
  }

  const summary = await importProspects(user.id, parsed.valid);

  return {
    redirect: '/prospects',
    ok: `Imported ${summary.created}. Skipped ${summary.skipped} duplicate(s), ${summary.failed} failed, ${parsed.invalid.length} rejected during validation.`,
  };
});
