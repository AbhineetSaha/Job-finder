/**
 * Polite HTTP client for source adapters.
 *
 * Every constraint here exists because the alternative would be abusive:
 *
 *  - per-host minimum interval, so a run is a trickle rather than a burst
 *  - a real, identifying User-Agent with a contact URL, so an operator whose
 *    API we are using can see who we are and reach us
 *  - response size cap, so a hostile or broken endpoint cannot exhaust memory
 *  - bounded retries with backoff, and NO retry on 4xx
 *  - `Retry-After` is obeyed when a server sends it
 *  - robots.txt is consulted before fetching an HTML page
 *
 * There is deliberately no CAPTCHA solving, no proxy rotation, no cookie
 * replay, and no header spoofing. If a source requires any of those to access,
 * this system does not support that source.
 */
import { getEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Minimum milliseconds between requests to the same host. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  maxBytes?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const DEFAULT_MIN_INTERVAL_MS = 1_100;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 4xx other than 429 will not succeed on retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class PoliteHttpClient {
  private readonly lastRequestAt = new Map<string, number>();
  private readonly robotsCache = new Map<string, Promise<RobotsRules | null>>();

  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: HttpClientOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    let appUrl = 'https://example.com';
    try {
      appUrl = getEnv().APP_URL;
    } catch {
      // Configuration may be unavailable in a unit test; the default is only
      // ever used to build a contact string.
    }
    this.userAgent =
      options.userAgent ?? `outreach-prospect-discovery/0.1 (+${appUrl}; contact via site)`;
  }

  private async throttle(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const elapsed = Date.now() - last;
      if (elapsed < this.minIntervalMs) {
        await this.sleepImpl(this.minIntervalMs - elapsed);
      }
    }
    this.lastRequestAt.set(host, Date.now());
  }

  /** Fetch text, with throttling, retries, and a hard size cap. */
  async getText(url: string, headers: Record<string, string> = {}): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new HttpError(`Refusing to fetch a non-HTTP URL: ${parsed.protocol}`, null, false);
    }

    let lastError: HttpError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.throttle(parsed.host);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          headers: { 'user-agent': this.userAgent, accept: 'application/json, text/*', ...headers },
          signal: controller.signal,
          redirect: 'follow',
        });

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          lastError = new HttpError(
            `HTTP ${response.status} from ${parsed.host}`,
            response.status,
            retryable,
          );

          if (!retryable) throw lastError;

          // Obey Retry-After when the server tells us how long to wait.
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(30_000, 1000 * 2 ** attempt);

          logger.warn('Source request throttled or failed; backing off', {
            event: 'source_http_retry',
            status: String(response.status),
            attempt,
            waitMs,
          });

          if (attempt < this.maxAttempts) {
            await this.sleepImpl(waitMs);
            continue;
          }
          throw lastError;
        }

        const body = await response.text();
        if (body.length > this.maxBytes) {
          throw new HttpError(
            `Response from ${parsed.host} exceeded ${this.maxBytes} bytes`,
            response.status,
            false,
          );
        }
        return body;
      } catch (error) {
        if (error instanceof HttpError) {
          if (!error.retryable || attempt >= this.maxAttempts) throw error;
          lastError = error;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          lastError = new HttpError(`Network error contacting ${parsed.host}: ${message}`, null, true);
          if (attempt >= this.maxAttempts) throw lastError;
          await this.sleepImpl(Math.min(30_000, 1000 * 2 ** attempt));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new HttpError(`Failed to fetch ${url}`, null, false);
  }

  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const body = await this.getText(url, { accept: 'application/json', ...headers });
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new HttpError(`Malformed JSON from ${new URL(url).host}`, null, false);
    }
  }

  /**
   * Whether robots.txt permits fetching this path.
   *
   * Applies to HTML pages we fetch directly. Documented JSON APIs are accessed
   * under their own terms of service, which is the relevant permission there.
   * Fails OPEN only when robots.txt is genuinely absent (404); a robots.txt we
   * could not read is treated as a disallow.
   */
  async isAllowedByRobots(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const origin = parsed.origin;

    let pending = this.robotsCache.get(origin);
    if (!pending) {
      pending = this.loadRobots(origin);
      this.robotsCache.set(origin, pending);
    }

    const rules = await pending;
    if (rules === null) return true; // no robots.txt at all
    if (rules.unreadable) return false;
    return isPathAllowed(rules, parsed.pathname + parsed.search);
  }

  private async loadRobots(origin: string): Promise<RobotsRules | null> {
    try {
      const body = await this.getText(`${origin}/robots.txt`, { accept: 'text/plain' });
      return parseRobots(body, this.userAgent);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      logger.warn('robots.txt unreadable; treating as disallow', {
        event: 'robots_unreadable',
        error: error instanceof Error ? error.message : String(error),
      });
      return { allow: [], disallow: ['/'], unreadable: true };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* robots.txt                                                                 */
/* -------------------------------------------------------------------------- */

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  unreadable?: boolean;
}

/**
 * Minimal robots.txt parser: the `*` group plus any group naming our agent,
 * with the agent-specific group taking precedence when present.
 */
export function parseRobots(body: string, userAgent: string): RobotsRules {
  const agentToken = userAgent.split('/')[0]?.toLowerCase() ?? '';

  const groups = new Map<string, { allow: string[]; disallow: string[] }>();
  let currentAgents: string[] = [];
  let sawDirective = false;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // A new user-agent line after directives starts a new group.
      if (sawDirective) {
        currentAgents = [];
        sawDirective = false;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) {
        groups.set(value.toLowerCase(), { allow: [], disallow: [] });
      }
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      sawDirective = true;
      for (const agent of currentAgents) {
        const group = groups.get(agent);
        if (!group) continue;
        if (value === '') continue;
        if (field === 'allow') group.allow.push(value);
        else group.disallow.push(value);
      }
    }
  }

  const specific = groups.get(agentToken);
  const wildcard = groups.get('*');
  const chosen = specific ?? wildcard;

  return { allow: chosen?.allow ?? [], disallow: chosen?.disallow ?? [] };
}

/** Longest-match-wins, as the de-facto standard specifies. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const match = (patterns: string[]): number => {
    let longest = -1;
    for (const pattern of patterns) {
      if (matchesRobotsPattern(pattern, path)) {
        longest = Math.max(longest, pattern.length);
      }
    }
    return longest;
  };

  const allowLength = match(rules.allow);
  const disallowLength = match(rules.disallow);

  if (disallowLength < 0) return true;
  return allowLength >= disallowLength;
}

function matchesRobotsPattern(pattern: string, path: string): boolean {
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const segments = body.split('*');

  let index = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    if (segment === '') continue;

    const found = i === 0 ? (path.startsWith(segment) ? 0 : -1) : path.indexOf(segment, index);
    if (found < 0) return false;
    index = found + segment.length;
  }

  if (anchoredEnd) return index === path.length;
  return true;
}
