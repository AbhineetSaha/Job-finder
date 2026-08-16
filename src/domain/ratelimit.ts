/**
 * Rate limiting. Pure, no I/O — the caller supplies the counts it read from
 * the send ledger, and this decides.
 *
 * Limits are evaluated in the campaign's timezone so "20 per day" means a
 * business day the operator recognises, not a UTC day that rolls over at 7pm.
 */

export interface RateLimitConfig {
  dailyLimit: number;
  hourlyLimit: number;
  perDomainDailyLimit: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
}

export interface RateLimitCounts {
  /** Sends since local midnight in the evaluation timezone. */
  sentToday: number;
  /** Sends in the trailing 60 minutes. */
  sentLastHour: number;
  /** Sends to this recipient's domain since local midnight. */
  sentToDomainToday: number;
  /** When the most recent send happened, for minimum-spacing enforcement. */
  lastSentAt: Date | null;
}

export type RateLimitReason =
  | 'DAILY_LIMIT_REACHED'
  | 'HOURLY_LIMIT_REACHED'
  | 'DOMAIN_LIMIT_REACHED'
  | 'MIN_DELAY_NOT_ELAPSED';

export interface RateLimitResult {
  allowed: boolean;
  reason: RateLimitReason | null;
  detail: string;
  /** When a retry could succeed, when that is knowable. */
  retryAfter: Date | null;
}

const ALLOWED: RateLimitResult = {
  allowed: true,
  reason: null,
  detail: 'Within all configured limits.',
  retryAfter: null,
};

/**
 * Check every limit. A limit of 0 means "no sends permitted", not "unlimited" —
 * the safe reading of a zero.
 */
export function checkRateLimits(
  config: RateLimitConfig,
  counts: RateLimitCounts,
  now: Date,
): RateLimitResult {
  if (counts.sentToday >= config.dailyLimit) {
    return {
      allowed: false,
      reason: 'DAILY_LIMIT_REACHED',
      detail: `Daily limit of ${config.dailyLimit} reached (${counts.sentToday} sent today).`,
      retryAfter: null, // resolved by the caller against the local day boundary
    };
  }

  if (counts.sentLastHour >= config.hourlyLimit) {
    return {
      allowed: false,
      reason: 'HOURLY_LIMIT_REACHED',
      detail: `Hourly limit of ${config.hourlyLimit} reached (${counts.sentLastHour} in the last hour).`,
      retryAfter: new Date(now.getTime() + 60 * 60 * 1000),
    };
  }

  if (counts.sentToDomainToday >= config.perDomainDailyLimit) {
    return {
      allowed: false,
      reason: 'DOMAIN_LIMIT_REACHED',
      detail: `Per-domain daily limit of ${config.perDomainDailyLimit} reached for this recipient's domain.`,
      retryAfter: null,
    };
  }

  if (counts.lastSentAt && config.minDelaySeconds > 0) {
    const earliest = new Date(counts.lastSentAt.getTime() + config.minDelaySeconds * 1000);
    if (now < earliest) {
      return {
        allowed: false,
        reason: 'MIN_DELAY_NOT_ELAPSED',
        detail: `Minimum spacing of ${config.minDelaySeconds}s between sends has not elapsed.`,
        retryAfter: earliest,
      };
    }
  }

  return ALLOWED;
}

/**
 * A randomised delay in [min, max] seconds, used to space sends so they do not
 * arrive in a machine-gun burst.
 *
 * This is traffic shaping for deliverability and recipient experience, not an
 * attempt to look human to a filter — the system never tries to evade spam
 * detection (brief §29).
 */
export function nextSendDelaySeconds(
  config: RateLimitConfig,
  random: () => number = Math.random,
): number {
  const min = Math.max(0, Math.min(config.minDelaySeconds, config.maxDelaySeconds));
  const max = Math.max(config.minDelaySeconds, config.maxDelaySeconds);
  if (max === min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Exponential backoff with full jitter, capped. Used for transient provider
 * failures; permanent failures are not retried at all.
 */
export function retryDelaySeconds(
  attempt: number,
  options: { baseSeconds?: number; maxSeconds?: number } = {},
  random: () => number = Math.random,
): number {
  const base = options.baseSeconds ?? 30;
  const cap = options.maxSeconds ?? 3600;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  // Full jitter: spreads a thundering herd of retries after a provider outage.
  return Math.max(1, Math.floor(random() * exponential));
}

export function shouldRetry(attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts;
}
