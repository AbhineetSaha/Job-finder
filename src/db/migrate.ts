/**
 * Applies checked-in migrations. Idempotent — safe to run on every deploy.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeDb, getDb } from './client.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder });
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isMain) {
  runMigrations()
    .then(async () => {
      // eslint-disable-next-line no-console
      console.log('migrations applied');
      await closeDb();
    })
    .catch(async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('migration failed:', err);
      await closeDb();
      process.exit(1);
    });
}
