/**
 * Structured JSON logging to stdout.
 *
 * Every send-path line carries the identifiers listed in brief §55 so a single
 * message can be traced end to end. Values are redacted before serialisation
 * so a secret cannot reach the log by being passed in a context object.
 */
import { getEnv } from './env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  requestId?: string;
  userId?: string;
  prospectId?: string;
  companyId?: string;
  contactId?: string;
  campaignId?: string;
  messageId?: string;
  jobId?: string;
  event?: string;
  status?: string;
  error?: string;
  [key: string]: unknown;
}

/** Keys whose values are never logged, matched case-insensitively as substrings. */
const REDACT_KEY_PATTERNS = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'session',
  'credential',
  'database_url',
  'connectionstring',
];

const REDACTED = '[redacted]';

function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      output[key] = shouldRedact(key) ? REDACTED : redact(inner, depth + 1);
    }
    return output;
  }
  return value;
}

function currentLevel(): LogLevel {
  try {
    return getEnv().LOG_LEVEL;
  } catch {
    // Logging must work even when configuration is invalid — that failure is
    // itself something worth logging.
    return 'info';
  }
}

function emit(level: LogLevel, message: string, context: LogContext = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;

  const line = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(redact(context) as Record<string, unknown>),
  };

  const serialized = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
  /** A logger with baked-in context, for a request or a job. */
  child(base: LogContext) {
    return {
      debug: (message: string, context?: LogContext) => emit('debug', message, { ...base, ...context }),
      info: (message: string, context?: LogContext) => emit('info', message, { ...base, ...context }),
      warn: (message: string, context?: LogContext) => emit('warn', message, { ...base, ...context }),
      error: (message: string, context?: LogContext) => emit('error', message, { ...base, ...context }),
    };
  },
};

export type Logger = typeof logger;

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

const counters = new Map<string, number>();

export const METRIC_NAMES = [
  'emails_attempted',
  'emails_sent',
  'emails_failed',
  'emails_blocked',
  'emails_bounced',
  'replies',
  'followups',
  'queue_failures',
  'provider_errors',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export function incrementMetric(name: MetricName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function snapshotMetrics(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const name of METRIC_NAMES) snapshot[name] = counters.get(name) ?? 0;
  return snapshot;
}

export function resetMetrics(): void {
  counters.clear();
}
