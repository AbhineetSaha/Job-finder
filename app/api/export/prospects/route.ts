import { downloadAction } from '../../../_components/handler.js';
import { exportProspectsCsv } from '../../../../src/services/ops.js';

export const GET = downloadAction(async (user) => ({
  body: await exportProspectsCsv(user.id),
  filename: `prospects-${new Date().toISOString().slice(0, 10)}.csv`,
  contentType: 'text/csv; charset=utf-8',
}));
