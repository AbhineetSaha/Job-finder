/**
 * The prospect source abstraction (brief §11).
 *
 * A source discovers *companies*, not people. It never produces an email
 * address it invented — only one the company or a person at it published.
 * Everything a source returns lands in a staging table for human review; no
 * source can create a prospect, enrol anyone in a campaign, or send anything.
 */
import type { RawCandidate } from '../domain/discovery.js';
import type { PoliteHttpClient } from './http.js';

export interface DiscoverContext {
  http: PoliteHttpClient;
  /** Adapter-specific configuration from the `discovery_sources` row. */
  config: Record<string, unknown>;
  /** Upper bound on items to return, so a run is always bounded. */
  limit: number;
  /** Aborts a long-running discovery cleanly. */
  signal?: AbortSignal;
}

export interface DiscoverResult {
  candidates: RawCandidate[];
  /** How many raw items were examined, before any filtering. */
  itemsFetched: number;
  /** Non-fatal problems worth surfacing on the run record. */
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface ProspectSource {
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  /**
   * What this source is permitted to access and why, shown in the UI so the
   * operator can see the basis for each source at a glance.
   */
  readonly accessBasis: string;
  /** Whether the source needs credentials the operator has not supplied. */
  isConfigured(config: Record<string, unknown>): boolean;
  discover(context: DiscoverContext): Promise<DiscoverResult>;
}

/** Clamp a configured limit so a misconfiguration cannot start an unbounded run. */
export function boundedLimit(requested: unknown, fallback = 50, max = 500): number {
  const value = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.trunc(value));
}

export function configString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function configStringArray(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}
