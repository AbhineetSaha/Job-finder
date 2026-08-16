/**
 * Effective runtime configuration.
 *
 * Environment variables supply defaults; a populated column on the user's
 * `settings` row overrides them. That layering is what lets the operator
 * tighten a limit or hit the global pause at 2am without a redeploy
 * (docs/operations.md).
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings, type Settings } from '../db/schema.js';
import { getEnv } from '../lib/env.js';
import type { RateLimitConfig } from '../domain/ratelimit.js';
import { isValidTimeZone } from '../domain/timezone.js';

export interface EffectiveConfig {
  globalSendPaused: boolean;
  globalPauseReason: string | null;
  rateLimits: RateLimitConfig;
  defaultTimezone: string;
  followupEnabled: boolean;
  qualificationWeights: Record<string, number> | null;
  postalAddress: string;
  unsubscribeFooter: string;
  advertisingDisclosure: string;
  retention: {
    activities: number | null;
    messages: number | null;
    webhookEvents: number | null;
  };
}

/** Create the settings row on first use so callers never handle its absence. */
export async function ensureSettings(userId: string): Promise<Settings> {
  const db = getDb();
  const existing = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(settings)
    .values({ userId })
    .onConflictDoNothing({ target: settings.userId })
    .returning();

  if (inserted[0]) return inserted[0];

  // Lost the insert race; the row now exists.
  const reread = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  const row = reread[0];
  if (!row) throw new Error(`Failed to create settings for user ${userId}`);
  return row;
}

function pickInt(override: number | null | undefined, fallback: number): number {
  return typeof override === 'number' && Number.isFinite(override) && override >= 0
    ? override
    : fallback;
}

export function resolveConfig(row: Settings): EffectiveConfig {
  const env = getEnv();

  const configuredTimezone = row.defaultTimezone;
  const defaultTimezone =
    configuredTimezone && isValidTimeZone(configuredTimezone)
      ? configuredTimezone
      : env.DEFAULT_TIMEZONE;

  return {
    globalSendPaused: row.globalSendPaused,
    globalPauseReason: row.globalPauseReason,
    rateLimits: {
      dailyLimit: pickInt(row.dailySendLimit, env.DAILY_SEND_LIMIT),
      hourlyLimit: pickInt(row.hourlySendLimit, env.HOURLY_SEND_LIMIT),
      perDomainDailyLimit: pickInt(row.perDomainDailyLimit, env.PER_DOMAIN_SEND_LIMIT),
      minDelaySeconds: pickInt(row.minDelaySeconds, env.MIN_SEND_DELAY_SECONDS),
      maxDelaySeconds: pickInt(row.maxDelaySeconds, env.MAX_SEND_DELAY_SECONDS),
    },
    defaultTimezone,
    // Follow-ups are on unless either layer turns them off.
    followupEnabled: row.followupEnabled === null ? env.FOLLOWUP_ENABLED : row.followupEnabled,
    qualificationWeights: row.qualificationWeights,
    postalAddress: row.postalAddress,
    unsubscribeFooter: row.unsubscribeFooter,
    advertisingDisclosure: row.advertisingDisclosure,
    retention: {
      activities: row.retentionDaysActivities,
      messages: row.retentionDaysMessages,
      webhookEvents: row.retentionDaysWebhookEvents,
    },
  };
}

export async function getConfig(userId: string): Promise<EffectiveConfig> {
  return resolveConfig(await ensureSettings(userId));
}
