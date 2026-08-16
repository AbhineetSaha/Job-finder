/** Scheduler entrypoint. Pass --once to run a single pass and exit (for cron). */
import { closeDb } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { runHousekeeping, runScheduler, runSchedulerOnce } from './scheduler.js';

const once = process.argv.includes('--once');
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('Shutdown signal received', { event: 'scheduler_shutdown', status: signal });
    controller.abort();
  });
}

const run = once
  ? runSchedulerOnce().then(async (result) => {
      logger.info('Single scheduler pass complete', { event: 'scheduler_once', ...result });
      await runHousekeeping();
    })
  : runScheduler(60_000, controller.signal);

run
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    logger.error('Scheduler crashed', {
      event: 'scheduler_crashed',
      error: error instanceof Error ? error.message : String(error),
    });
    await closeDb();
    process.exit(1);
  });
