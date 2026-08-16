import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from '../lib/env.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let database: Database | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // A pool-level error (e.g. the database restarting) must not take the
    // process down; the next checkout will reconnect.
    pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ event: 'pg_pool_error', error: err.message }));
    });
  }
  return pool;
}

export function getDb(): Database {
  database ??= drizzle(getPool(), { schema });
  return database;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    database = null;
  }
}

export { schema };
