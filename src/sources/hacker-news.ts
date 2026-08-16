/**
 * Hacker News "Ask HN: Who is hiring?" source.
 *
 * Access basis: the Algolia HN Search API is a public, documented, no-auth API
 * that HN provides for exactly this kind of use. The content it returns is job
 * posts written by companies *asking* to be contacted, which makes it the most
 * legitimate free source available for "startups hiring engineers with a
 * specific stack".
 *
 * The conventional first line of a post is:
 *
 *   Company | Location | Role | Remote/Onsite | Salary | url
 *
 * Adherence is imperfect, so parsing is defensive: an unparseable post is
 * skipped rather than guessed at.
 */
import {
  boundedLimit,
  configString,
  configStringArray,
  type DiscoverContext,
  type DiscoverResult,
  type ProspectSource,
} from './types.js';
import type { RawCandidate } from '../domain/discovery.js';
import { detectFundingSignals, detectHiringSignals, extractPublishedEmails, extractTechnologies } from '../domain/discovery.js';
import { normalizeDomain } from '../domain/normalize.js';

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

interface AlgoliaStoryHit {
  objectID: string;
  title: string;
  created_at: string;
}

interface AlgoliaSearchResponse {
  hits: AlgoliaStoryHit[];
}

interface AlgoliaItem {
  id: number;
  title?: string | null;
  author?: string | null;
  text?: string | null;
  created_at?: string | null;
  children?: AlgoliaItem[];
}

/** Convert HN comment HTML to plain text without an HTML parser dependency. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*p\s*>/gi, '\n\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ParsedJobPost {
  companyName: string;
  locationText: string | null;
  role: string | null;
  website: string | null;
  body: string;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')]+/gi;

/**
 * Parse one job post. Returns null when the first line does not look like a
 * company header — better to skip a post than to invent a company name.
 */
export function parseJobPost(text: string): ParsedJobPost | null {
  const body = text.trim();
  if (!body) return null;

  const firstLine = (body.split('\n')[0] ?? '').trim();
  if (!firstLine) return null;

  // The convention is pipe-separated. Some posters use an em dash or a slash.
  const parts = firstLine
    .split(/\s*[|•]\s*|\s+[—–]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const companyName = parts[0] ?? '';

  // Guard rails against treating a prose sentence as a company name.
  if (!companyName) return null;
  if (companyName.length > 80) return null;
  if (companyName.split(/\s+/).length > 8) return null;
  if (/^(hi|hello|we|our|i'm|i am|at )\b/i.test(companyName)) return null;

  const remainder = parts.slice(1);

  // Location is whichever remaining segment looks geographic, else the first.
  const locationText =
    remainder.find((p) => /remote|onsite|hybrid|,|\b[A-Z]{2}\b|USA|US|UK|EU/i.test(p)) ??
    remainder[0] ??
    null;

  const role = remainder.find((p) => /engineer|developer|dev\b|manager|lead|architect|designer/i.test(p)) ?? null;

  const urls = body.match(URL_IN_TEXT) ?? [];
  // Prefer a URL that is not a job board, since we want the company site.
  const website =
    urls.find((u) => !/(greenhouse|lever|workable|ashby|jobs|boards|angel|linkedin)\./i.test(u)) ??
    urls[0] ??
    null;

  return { companyName, locationText, role, website, body };
}

export const hackerNewsSource: ProspectSource = {
  kind: 'hacker-news',
  name: 'Hacker News — Who is hiring?',
  description:
    'Monthly "Ask HN: Who is hiring?" threads. Companies post their own openings with stack and contact details.',
  accessBasis:
    'Public, documented, no-auth Algolia HN Search API. Content is posted by companies inviting contact.',

  isConfigured(): boolean {
    return true;
  },

  async discover(context: DiscoverContext): Promise<DiscoverResult> {
    const limit = boundedLimit(context.config.limit, 60, 300);
    const monthsBack = Math.min(6, Math.max(1, Number(context.config.monthsBack) || 2));
    const requiredKeywords = configStringArray(context.config, 'keywords');
    const storyIdOverride = configString(context.config, 'storyId');

    const warnings: string[] = [];
    const candidates: RawCandidate[] = [];
    let itemsFetched = 0;

    // 1. Find the recent "Who is hiring?" stories. They are posted by the
    //    `whoishiring` account, which makes them unambiguous to identify.
    let storyIds: string[] = [];

    if (storyIdOverride) {
      storyIds = [storyIdOverride];
    } else {
      const search = await context.http.getJson<AlgoliaSearchResponse>(
        `${ALGOLIA_BASE}/search_by_date?tags=story,author_whoishiring&hitsPerPage=${monthsBack * 3}`,
      );
      storyIds = search.hits
        .filter((hit) => /who is hiring/i.test(hit.title ?? ''))
        .slice(0, monthsBack)
        .map((hit) => hit.objectID);
    }

    if (storyIds.length === 0) {
      warnings.push('No "Who is hiring?" threads were found.');
      return { candidates, itemsFetched: 0, warnings, metadata: { storyIds } };
    }

    // 2. Each thread's top-level comments are the job posts.
    for (const storyId of storyIds) {
      if (context.signal?.aborted) break;
      if (candidates.length >= limit) break;

      let item: AlgoliaItem;
      try {
        item = await context.http.getJson<AlgoliaItem>(`${ALGOLIA_BASE}/items/${storyId}`);
      } catch (error) {
        warnings.push(
          `Could not fetch thread ${storyId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      for (const child of item.children ?? []) {
        if (candidates.length >= limit) break;
        if (!child.text) continue;

        itemsFetched += 1;

        const text = htmlToText(child.text);
        // Require every configured keyword, so "postgres AND remote" narrows
        // rather than widens.
        if (
          requiredKeywords.length > 0 &&
          !requiredKeywords.every((keyword) => text.toLowerCase().includes(keyword.toLowerCase()))
        ) {
          continue;
        }

        const parsed = parseJobPost(text);
        if (!parsed) continue;

        const emails = extractPublishedEmails(text);

        candidates.push({
          companyName: parsed.companyName,
          website: parsed.website,
          domain: normalizeDomain(parsed.website),
          description: parsed.body.slice(0, 1500),
          locationText: parsed.locationText,
          technologyStack: extractTechnologies(text),
          fundingSignals: detectFundingSignals(text),
          hiringSignals: detectHiringSignals(text),
          // Only an address the poster published in their own job post.
          publishedEmail: emails[0] ?? null,
          contactRole: parsed.role,
          sourceUrl: `https://news.ycombinator.com/item?id=${child.id}`,
          signalText: text,
          raw: { hnItemId: child.id, storyId, author: child.author ?? null },
        });
      }
    }

    return {
      candidates,
      itemsFetched,
      warnings,
      metadata: { storyIds, monthsBack, requiredKeywords },
    };
  },
};
