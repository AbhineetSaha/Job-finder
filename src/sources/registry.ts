/**
 * Source registry. Adding a source is registering it here and nowhere else.
 */
import type { ProspectSource } from './types.js';
import { hackerNewsSource } from './hacker-news.js';
import { githubSource } from './github.js';
import { secFormDSource } from './sec-form-d.js';

const SOURCES: ProspectSource[] = [hackerNewsSource, githubSource, secFormDSource];

export function listSources(): ProspectSource[] {
  return [...SOURCES];
}

export function getSource(kind: string): ProspectSource | null {
  return SOURCES.find((source) => source.kind === kind) ?? null;
}

export * from './types.js';
export { PoliteHttpClient } from './http.js';
