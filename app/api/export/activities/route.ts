import { downloadAction } from '../../../_components/handler.js';
import { exportActivitiesCsv } from '../../../../src/services/ops.js';

export const GET = downloadAction(async (user) => ({
  body: await exportActivitiesCsv(user.id),
  filename: `activities-${new Date().toISOString().slice(0, 10)}.csv`,
  contentType: 'text/csv; charset=utf-8',
}));
