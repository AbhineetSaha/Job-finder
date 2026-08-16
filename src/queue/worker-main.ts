/** Worker entrypoint. */
import { randomUUID } from 'node:crypto';
import { closeDb } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { runWorker } from './worker.js';

const controller = new AbortController();
const workerId = process.env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('Shutdown signal received', { event: 'worker_shutdown', status: signal });
    controller.abort();
  });
}

runWorker({ workerId }, controller.signal)
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    logger.error('Worker crashed', {
      event: 'worker_crashed',
      error: error instanceof Error ? error.message : String(error),
    });
    await closeDb();
    process.exit(1);
  });
