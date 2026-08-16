/**
 * Drops and recreates the schema, then re-applies migrations.
 * Development only — refuses to run against a production configuration.
 */
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from './client.js';
import { getEnv } from '../lib/env.js';
import { runMigrations } from './migrate.js';

async function reset(): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === 'production' || env.EMAIL_MODE === 'production') {
    throw new Error('Refusing to reset the database in a production configuration.');
  }

  await getDb().execute(sql`drop schema public cascade; create schema public;`);
  await runMigrations();
  // eslint-disable-next-line no-console
  console.log('Database reset and migrations reapplied.');
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  reset()
    .then(closeDb)
    .catch(async (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Reset failed:', error);
      await closeDb();
      process.exit(1);
    });
}

export { reset };
