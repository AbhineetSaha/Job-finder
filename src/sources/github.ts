/**
 * GitHub organisation source.
 *
 * Access basis: the official GitHub REST API, used within its documented rate
 * limits. Only public organisation profile data is read — name, description,
 * blog URL, location, and the email the organisation chose to publish on its
 * public profile.
 *
 * This is the strongest source for *technology matching*, because it finds
 * companies by the language and topics of the code they actually ship.
 *
 * A token is optional but strongly recommended: unauthenticated search is
 * limited to roughly 10 requests per minute, which makes any useful run slow.
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
import { detectFundingSignals, detectHiringSignals, extractTechnologies } from '../domain/discovery.js';
import { normalizeDomain } from '../domain/normalize.js';

const API_BASE = 'https://api.github.com';

interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  pushed_at: string;
  owner: { login: string; type: string; html_url: string };
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubRepo[];
}

interface GitHubOrg {
  login: string;
  name: string | null;
  description: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  twitter_username: string | null;
  public_repos: number;
  html_url: string;
  type: string;
}

/**
 * Build the search qualifier string.
 *
 * Defaults bias toward active, non-toy repositories: recently pushed, with
 * enough stars to suggest a real product rather than a weekend project.
 */
export function buildRepoQuery(config: Record<string, unknown>): string {
  const languages = configStringArray(config, 'languages');
  const topics = configStringArray(config, 'topics');
  const minStars = Number(config.minStars) || 50;
  const pushedSince =
    configString(config, 'pushedSince') ??
    new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const parts: string[] = [];
  for (const language of languages) parts.push(`language:${language}`);
  for (const topic of topics) parts.push(`topic:${topic}`);
  parts.push(`stars:>=${minStars}`);
  parts.push(`pushed:>=${pushedSince}`);
  // Archived and forked repositories say nothing about a company's current work.
  parts.push('archived:false');
  parts.push('fork:false');

  return parts.join(' ');
}

export const githubSource: ProspectSource = {
  kind: 'github',
  name: 'GitHub — organisations by technology',
  description:
    'Finds organisations shipping code in your stack, using repository language and topic search.',
  accessBasis:
    'Official GitHub REST API within documented rate limits. Public organisation profile data only.',

  isConfigured(): boolean {
    // Works unauthenticated, just slowly. A token is a quality-of-life setting,
    // not a requirement, so the source is never reported as unconfigured.
    return true;
  },

  async discover(context: DiscoverContext): Promise<DiscoverResult> {
    const limit = boundedLimit(context.config.limit, 30, 200);
    const token = configString(context.config, 'token');
    const warnings: string[] = [];
    const candidates: RawCandidate[] = [];

    if (!token) {
      warnings.push(
        'No GitHub token configured. Unauthenticated search is limited to about 10 requests per minute, so this run will be slow and may return fewer results.',
      );
    }

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };

    const query = buildRepoQuery(context.config);
    const perPage = Math.min(100, limit);

    let search: GitHubSearchResponse;
    try {
      search = await context.http.getJson<GitHubSearchResponse>(
        `${API_BASE}/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}`,
        headers,
      );
    } catch (error) {
      throw new Error(
        `GitHub repository search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const itemsFetched = search.items.length;

    // One organisation may own several matching repositories; group so the
    // organisation is fetched once and its repos inform one candidate.
    const byOwner = new Map<string, GitHubRepo[]>();
    for (const repo of search.items) {
      // Personal accounts are individuals, not companies with a budget.
      if (repo.owner.type !== 'Organization') continue;
      const list = byOwner.get(repo.owner.login) ?? [];
      list.push(repo);
      byOwner.set(repo.owner.login, list);
    }

    for (const [login, repos] of byOwner) {
      if (context.signal?.aborted) break;
      if (candidates.length >= limit) break;

      let org: GitHubOrg;
      try {
        org = await context.http.getJson<GitHubOrg>(`${API_BASE}/orgs/${login}`, headers);
      } catch (error) {
        warnings.push(
          `Could not read organisation ${login}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const repoText = repos
        .map((r) => [r.full_name, r.description, r.language, ...(r.topics ?? [])].filter(Boolean).join(' '))
        .join('\n');
      const signalText = [org.description, org.location, repoText].filter(Boolean).join('\n');

      const languages = [...new Set(repos.map((r) => r.language).filter((l): l is string => Boolean(l)))];

      candidates.push({
        companyName: org.name?.trim() || org.login,
        website: org.blog,
        domain: normalizeDomain(org.blog),
        description: org.description,
        locationText: org.location,
        // Declared repository languages plus anything recognised in the text.
        technologyStack: [...new Set([...languages, ...extractTechnologies(signalText)])],
        fundingSignals: detectFundingSignals(signalText),
        hiringSignals: detectHiringSignals(signalText),
        // Only the address the organisation published on its public profile.
        publishedEmail: org.email,
        sourceUrl: org.html_url,
        signalText,
        raw: {
          login: org.login,
          publicRepos: org.public_repos,
          matchedRepos: repos.slice(0, 10).map((r) => ({
            name: r.full_name,
            url: r.html_url,
            stars: r.stargazers_count,
            language: r.language,
          })),
        },
      });
    }

    return {
      candidates,
      itemsFetched,
      warnings,
      metadata: { query, totalCount: search.total_count, organisations: byOwner.size },
    };
  },
};
