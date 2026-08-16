/**
 * Server-only environment configuration.
 *
 * Parsed once, eagerly, so a misconfigured deployment fails at startup rather
 * than at the first send. Importing this module from a browser bundle throws.
 *
 * There are no AI-related variables here by design; see docs/architecture.md §9.
 */
import { z } from 'zod';

if (typeof window !== 'undefined') {
  throw new Error(
    'src/lib/env.ts was imported into a browser bundle. It holds secrets and must stay server-only.',
  );
}

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Coerce "1"/"true"/"yes"/"on" to true; everything else to false. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const intish = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters'),

  EMAIL_MODE: z.enum(['mock', 'production']).default('mock'),
  EMAIL_PROVIDER: z.enum(['mock', 'resend']).default('mock'),
  EMAIL_API_KEY: optionalString,
  EMAIL_FROM: optionalString,
  EMAIL_REPLY_TO: optionalString,
  EMAIL_WEBHOOK_SECRET: optionalString,
  WEBHOOK_TOLERANCE_SECONDS: intish(300, 30, 3600),

  DAILY_SEND_LIMIT: intish(20, 0, 2000),
  HOURLY_SEND_LIMIT: intish(5, 0, 500),
  PER_DOMAIN_SEND_LIMIT: intish(2, 0, 500),
  MIN_SEND_DELAY_SECONDS: intish(90, 0, 86_400),
  MAX_SEND_DELAY_SECONDS: intish(600, 0, 86_400),

  DEFAULT_TIMEZONE: z
    .string()
    .default('America/New_York')
    .refine(isValidTimeZone, 'DEFAULT_TIMEZONE must be a valid IANA time zone'),
  FOLLOWUP_ENABLED: boolish(true),

  WORKER_POLL_INTERVAL_MS: intish(5000, 250, 300_000),
  WORKER_BATCH_SIZE: intish(5, 1, 100),
  WORKER_VISIBILITY_TIMEOUT_SECONDS: intish(300, 30, 3600),
  JOB_MAX_ATTEMPTS: intish(5, 1, 20),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/**
 * Production sending demands real credentials. This is the gate that makes
 * "no real emails during development" structural rather than a convention:
 * the mock provider is the only reachable one until every one of these is set.
 */
const schema = baseSchema
  .refine(
    (env) => env.MIN_SEND_DELAY_SECONDS <= env.MAX_SEND_DELAY_SECONDS,
    { message: 'MIN_SEND_DELAY_SECONDS must not exceed MAX_SEND_DELAY_SECONDS', path: ['MIN_SEND_DELAY_SECONDS'] },
  )
  .refine((env) => env.EMAIL_MODE !== 'production' || env.EMAIL_PROVIDER !== 'mock', {
    message: 'EMAIL_MODE=production requires a real EMAIL_PROVIDER',
    path: ['EMAIL_PROVIDER'],
  })
  .refine((env) => env.EMAIL_MODE !== 'production' || !!env.EMAIL_API_KEY, {
    message: 'EMAIL_MODE=production requires EMAIL_API_KEY',
    path: ['EMAIL_API_KEY'],
  })
  .refine((env) => env.EMAIL_MODE !== 'production' || !!env.EMAIL_FROM, {
    message: 'EMAIL_MODE=production requires EMAIL_FROM',
    path: ['EMAIL_FROM'],
  })
  .refine(
    (env) =>
      env.EMAIL_MODE !== 'production' ||
      (!!env.EMAIL_FROM && z.string().email().safeParse(env.EMAIL_FROM).success),
    { message: 'EMAIL_FROM must be a valid email address', path: ['EMAIL_FROM'] },
  );

export type Env = z.infer<typeof baseSchema>;

function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nSee .env.example for the full list.`,
    );
  }
  return result.data;
}

/** Exported for tests so configuration rules can be exercised without mutating process.env. */
export const parseEnvForTest = (source: NodeJS.ProcessEnv): Env => parseEnv(source);

let cached: Env | null = null;

/** Lazily parsed so importing a module for its types never forces configuration. */
export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

/** True when the system is permitted to reach a real email provider. */
export function isProductionSending(): boolean {
  return getEnv().EMAIL_MODE === 'production';
}
