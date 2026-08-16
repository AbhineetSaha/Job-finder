/**
 * SEC Form D source — companies that have just raised money.
 *
 * Access basis: EDGAR is US government public-domain data, published by the
 * SEC for exactly this kind of retrieval. Requests carry an identifying
 * User-Agent and are rate limited well below the SEC's fair-access threshold
 * of 10 requests per second.
 *
 * Why Form D specifically: it is the notice filed for an exempt securities
 * offering, which in practice means "this company just closed a funding
 * round". It is the most direct public funding signal that exists, and it is
 * free.
 *
 * Two honest limitations:
 *   - Form D is US-only, so this source cannot find funded startups elsewhere.
 *   - Filings carry no contact email. This source produces *company* leads
 *     with a funding signal; finding the right person is research you do.
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
import { inferCountry, isUsStateCode } from '../domain/discovery.js';

const ARCHIVES = 'https://www.sec.gov/Archives/edgar';
const SUBMISSIONS = 'https://data.sec.gov/submissions';

export interface IndexEntry {
  cik: string;
  companyName: string;
  formType: string;
  dateFiled: string;
  fileName: string;
}

/**
 * Parse EDGAR's pipe-delimited `master.idx`.
 *
 *   CIK|Company Name|Form Type|Date Filed|Filename
 *
 * The file has a preamble of dashes and headings before the data begins.
 */
export function parseMasterIndex(body: string, formTypes: string[]): IndexEntry[] {
  const wanted = new Set(formTypes.map((f) => f.toUpperCase()));
  const entries: IndexEntry[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('-')) continue;

    const parts = trimmed.split('|');
    if (parts.length < 5) continue;

    const [cik, companyName, formType, dateFiled, fileName] = parts;
    if (!cik || !companyName || !formType || !dateFiled || !fileName) continue;
    // Skip the header row, whose first column is the literal "CIK".
    if (!/^\d+$/.test(cik.trim())) continue;
    if (!wanted.has(formType.trim().toUpperCase())) continue;

    entries.push({
      cik: cik.trim(),
      companyName: companyName.trim(),
      formType: formType.trim().toUpperCase(),
      dateFiled: dateFiled.trim(),
      fileName: fileName.trim(),
    });
  }

  return entries;
}

interface SubmissionsResponse {
  name?: string;
  sic?: string;
  sicDescription?: string;
  phone?: string;
  entityType?: string;
  addresses?: {
    business?: {
      city?: string | null;
      stateOrCountry?: string | null;
      stateOrCountryDescription?: string | null;
    };
  };
}

/** `2025-01-02` → `{ year: 2025, quarter: 'QTR1', compact: '20250102' }` */
export function indexPathFor(date: Date): { year: number; quarter: string; compact: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return {
    year,
    quarter: `QTR${Math.floor((month - 1) / 3) + 1}`,
    compact: `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`,
  };
}

/** Business days back from `from`, since EDGAR publishes no weekend index. */
export function recentBusinessDays(from: Date, count: number): Date[] {
  const days: Date[] = [];
  const cursor = new Date(from.getTime());

  while (days.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(new Date(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return days;
}

export const secFormDSource: ProspectSource = {
  kind: 'sec-form-d',
  name: 'SEC Form D — recently funded US companies',
  description:
    'Companies that recently filed a Form D notice of an exempt offering, i.e. closed a funding round. US only.',
  accessBasis:
    'US government public-domain EDGAR data, retrieved with an identifying User-Agent well below the SEC fair-access rate limit.',

  isConfigured(): boolean {
    return true;
  },

  async discover(context: DiscoverContext): Promise<DiscoverResult> {
    const limit = boundedLimit(context.config.limit, 40, 200);
    const daysBack = Math.min(20, Math.max(1, Number(context.config.daysBack) || 5));

    // SIC 73xx is business services, which is where software companies sit.
    // Without this filter Form D is dominated by investment funds and real
    // estate partnerships, which are not prospects.
    const sicPrefixes = configStringArray(context.config, 'sicPrefixes');
    const prefixes = sicPrefixes.length > 0 ? sicPrefixes : ['73'];
    const asOf = configString(context.config, 'asOf');

    const warnings: string[] = [];
    const candidates: RawCandidate[] = [];
    let itemsFetched = 0;

    const startDate = asOf ? new Date(`${asOf}T00:00:00Z`) : new Date();
    const days = recentBusinessDays(startDate, daysBack);

    const seenCik = new Set<string>();
    const filings: IndexEntry[] = [];

    for (const day of days) {
      if (context.signal?.aborted) break;
      const { year, quarter, compact } = indexPathFor(day);

      let body: string;
      try {
        body = await context.http.getText(
          `${ARCHIVES}/daily-index/${year}/${quarter}/master.${compact}.idx`,
          { accept: 'text/plain' },
        );
      } catch {
        // A missing index is normal: holidays, and the current day before
        // EDGAR publishes. Not worth surfacing as a warning.
        continue;
      }

      for (const entry of parseMasterIndex(body, ['D', 'D/A'])) {
        itemsFetched += 1;
        if (seenCik.has(entry.cik)) continue;
        seenCik.add(entry.cik);
        filings.push(entry);
      }
    }

    // 2. Enrich each filer with its industry and address. One request per
    //    company, so the loop stops at the limit rather than fetching all.
    for (const filing of filings) {
      if (context.signal?.aborted) break;
      if (candidates.length >= limit) break;

      const paddedCik = filing.cik.padStart(10, '0');

      let submission: SubmissionsResponse;
      try {
        submission = await context.http.getJson<SubmissionsResponse>(
          `${SUBMISSIONS}/CIK${paddedCik}.json`,
        );
      } catch (error) {
        warnings.push(
          `Could not read submissions for CIK ${filing.cik}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      const sic = submission.sic ?? '';
      if (!prefixes.some((prefix) => sic.startsWith(prefix))) continue;

      const business = submission.addresses?.business;
      const stateOrCountry = business?.stateOrCountry ?? null;
      const description = business?.stateOrCountryDescription ?? null;

      // EDGAR puts a US state code here for domestic filers and a country
      // code for foreign ones, so a recognised state code means the US.
      const country = isUsStateCode(stateOrCountry) ? 'US' : inferCountry(description);

      const locationText = [business?.city, description].filter(Boolean).join(', ') || null;

      candidates.push({
        companyName: submission.name?.trim() || filing.companyName,
        description: submission.sicDescription
          ? `${submission.sicDescription} (SIC ${sic}). Filed ${filing.formType} on ${filing.dateFiled}.`
          : `Filed ${filing.formType} on ${filing.dateFiled}.`,
        locationText,
        country,
        // Form D IS the funding event; it does not need to be inferred from prose.
        fundingSignals: [`SEC ${filing.formType} filed ${filing.dateFiled}`],
        // Filings carry no contact email, and this system does not invent one.
        publishedEmail: null,
        sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=D&dateb=&owner=include&count=40`,
        signalText: [submission.sicDescription, locationText].filter(Boolean).join('\n'),
        raw: {
          cik: filing.cik,
          sic,
          sicDescription: submission.sicDescription ?? null,
          formType: filing.formType,
          dateFiled: filing.dateFiled,
          filingUrl: `${ARCHIVES.replace('/edgar', '')}/edgar/${filing.fileName}`,
        },
      });
    }

    if (filings.length > 0 && candidates.length === 0) {
      warnings.push(
        `Found ${filings.length} Form D filings but none matched SIC prefix ${prefixes.join(', ')}. Most Form D filers are investment funds rather than software companies.`,
      );
    }

    return {
      candidates,
      itemsFetched,
      warnings,
      metadata: { daysBack, sicPrefixes: prefixes, filingsSeen: filings.length },
    };
  },
};
