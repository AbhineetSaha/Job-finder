/**
 * Test bootstrap.
 *
 * Loads .env.test before any module reads configuration, and asserts that the
 * test run can never reach a real email provider. If EMAIL_MODE were ever
 * production here, the whole suite aborts rather than risk sending.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env.test');

try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    process.env[key] ??= value;
  }
} catch {
  // .env.test is optional when the environment is already configured.
}

if (process.env.EMAIL_MODE === 'production') {
  throw new Error(
    'EMAIL_MODE=production during tests. Refusing to run: tests must never be able to send real email.',
  );
}
