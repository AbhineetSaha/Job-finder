import { describe, expect, it } from 'vitest';
import {
  applyGeographyPolicy,
  canPromote,
  canonicalizeTech,
  classifyContactability,
  detectFundingSignals,
  detectHiringSignals,
  extractPublishedEmails,
  extractTechnologies,
  hasContractSignal,
  inferCountry,
  isUsStateCode,
  normalizeCandidate,
  scoreProfileMatch,
  type GeographyPolicy,
  type MatchProfile,
} from '../../src/domain/discovery.js';
import { htmlToText, parseJobPost } from '../../src/sources/hacker-news.js';
import { buildRepoQuery } from '../../src/sources/github.js';
import { indexPathFor, parseMasterIndex, recentBusinessDays } from '../../src/sources/sec-form-d.js';
import { isPathAllowed, parseRobots } from '../../src/sources/http.js';

const PROFILE: MatchProfile = {
  skills: ['Java', 'Spring Boot', 'TypeScript', 'Node.js', 'React', 'Next.js', 'PostgreSQL'],
  industries: ['SaaS', 'FinTech'],
};

/* -------------------------------------------------------------------------- */
/* Geography                                                                  */
/* -------------------------------------------------------------------------- */

describe('country inference', () => {
  it('recognises explicit countries', () => {
    expect(inferCountry('United States')).toBe('US');
    expect(inferCountry('London, UK')).toBe('GB');
    expect(inferCountry('Berlin, Germany')).toBe('DE');
    expect(inferCountry('Toronto, Canada')).toBe('CA');
    expect(inferCountry('Bangalore, India')).toBe('IN');
  });

  it('recognises the bare US forms common in job posts', () => {
    expect(inferCountry('Remote (US)')).toBe('US');
    expect(inferCountry('US')).toBe('US');
    expect(inferCountry('U.S.')).toBe('US');
    expect(inferCountry('Remote — US only')).toBe('US');
  });

  it('does not read the English pronoun "us" as a country', () => {
    expect(inferCountry('contact us for details')).toBeNull();
    expect(inferCountry('join us remotely')).toBeNull();
  });

  it('recognises US cities and state codes', () => {
    expect(inferCountry('San Francisco')).toBe('US');
    expect(inferCountry('Austin, TX')).toBe('US');
    expect(inferCountry('Brooklyn, NY')).toBe('US');
  });

  it('prefers an explicit country over a city that appears in it', () => {
    // An Indian city plus the country name must resolve to IN, not be
    // confused by any other pattern.
    expect(inferCountry('Bengaluru, India')).toBe('IN');
  });

  it('returns null rather than guessing', () => {
    expect(inferCountry('Remote')).toBeNull();
    expect(inferCountry('Anywhere')).toBeNull();
    expect(inferCountry('')).toBeNull();
    expect(inferCountry(null)).toBeNull();
  });

  it('identifies US state codes', () => {
    expect(isUsStateCode('CA')).toBe(true);
    expect(isUsStateCode('tx')).toBe(true);
    expect(isUsStateCode('ZZ')).toBe(false);
    expect(isUsStateCode(null)).toBe(false);
  });
});

describe('geography policy', () => {
  it('excludes India by default, as configured', () => {
    const decision = applyGeographyPolicy('IN');
    expect(decision.keep).toBe(false);
    expect(decision.contactability).toBe('EXCLUDED');
  });

  it('keeps the US and marks it an opt-out regime', () => {
    const decision = applyGeographyPolicy('US');
    expect(decision.keep).toBe(true);
    expect(decision.contactability).toBe('OPT_OUT_REGIME');
  });

  it('keeps EU/UK/Canada but marks them consent-required', () => {
    for (const country of ['DE', 'FR', 'GB', 'IE', 'CA', 'NL', 'SE']) {
      const decision = applyGeographyPolicy(country);
      expect(decision.keep, country).toBe(true);
      expect(decision.contactability, country).toBe('CONSENT_REQUIRED');
    }
  });

  it('honours a target-country allowlist', () => {
    const policy: GeographyPolicy = {
      excludedCountries: ['IN'],
      targetCountries: ['US'],
      allowUnknownCountry: false,
    };
    expect(applyGeographyPolicy('US', policy).keep).toBe(true);
    expect(applyGeographyPolicy('DE', policy).keep).toBe(false);
    expect(applyGeographyPolicy(null, policy).keep).toBe(false);
  });

  it('keeps unknown-country candidates for manual review by default', () => {
    const decision = applyGeographyPolicy(null);
    expect(decision.keep).toBe(true);
    expect(decision.contactability).toBe('UNKNOWN');
  });

  it('classifies contactability independently of the policy', () => {
    expect(classifyContactability('US')).toBe('OPT_OUT_REGIME');
    expect(classifyContactability('GB')).toBe('CONSENT_REQUIRED');
    expect(classifyContactability('BR')).toBe('UNKNOWN');
    expect(classifyContactability(null)).toBe('UNKNOWN');
  });
});

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

describe('technology extraction and matching', () => {
  it('canonicalises aliases', () => {
    expect(canonicalizeTech('postgres')).toBe('postgresql');
    expect(canonicalizeTech('PostgreSQL')).toBe('postgresql');
    expect(canonicalizeTech('nodejs')).toBe('node.js');
    expect(canonicalizeTech('Spring Boot')).toBe('spring boot');
    expect(canonicalizeTech('cobol')).toBeNull();
  });

  it('treats Node and JavaScript as distinct skills', () => {
    expect(canonicalizeTech('node')).toBe('node.js');
    expect(canonicalizeTech('javascript')).toBe('javascript');
  });

  it('extracts technologies from prose', () => {
    const found = extractTechnologies('We run Java and Spring Boot with Postgres behind a React SPA.');
    expect(found).toContain('java');
    expect(found).toContain('spring boot');
    expect(found).toContain('postgresql');
    expect(found).toContain('react');
  });

  it('respects word boundaries', () => {
    // "going" must not match "go", "reactive" must not match "react".
    expect(extractTechnologies('We are going to build a reactive system')).toEqual([]);
    expect(extractTechnologies('Built with Golang and Postgres')).toContain('go');
  });

  it('does not mine ambiguous two-letter aliases out of prose', () => {
    // "we go fast" is not a Go shop, and "ts" in prose is not TypeScript.
    expect(extractTechnologies('we go fast and ship')).toEqual([]);
    // The same token IS valid as an exact declared language, e.g. from GitHub.
    expect(canonicalizeTech('Go')).toBe('go');
    expect(canonicalizeTech('ts')).toBe('typescript');
  });

  it('scores overlap with the operator profile and explains every point', () => {
    const result = scoreProfileMatch(
      {
        technologyStack: ['TypeScript', 'PostgreSQL', 'React'],
        fundingSignals: ['Series A'],
        hiringSignals: ['Explicitly hiring'],
        description: 'A SaaS platform',
      },
      PROFILE,
    );

    // 3 technologies (30) + funding (20) + hiring (20) + industry (10)
    expect(result.score).toBe(80);
    expect(result.matchedTechnologies).toEqual(['postgresql', 'react', 'typescript']);
    expect(result.reasons.join(' ')).toContain('Technology match');
    expect(result.reasons.join(' ')).toContain('Funding signal');
    expect(result.reasons.join(' ')).toContain('Industry match: SaaS');
  });

  it('caps the technology contribution', () => {
    const result = scoreProfileMatch(
      {
        technologyStack: ['Java', 'Spring Boot', 'TypeScript', 'Node.js', 'React', 'Next.js', 'PostgreSQL'],
        fundingSignals: [],
        hiringSignals: [],
        description: null,
      },
      PROFILE,
    );
    expect(result.score).toBe(50);
  });

  it('scores zero and says so when nothing matches', () => {
    const result = scoreProfileMatch(
      { technologyStack: ['COBOL'], fundingSignals: [], hiringSignals: [], description: null },
      PROFILE,
    );
    expect(result.score).toBe(0);
    expect(result.reasons[0]).toContain('No recognised');
  });
});

/* -------------------------------------------------------------------------- */
/* Signals                                                                    */
/* -------------------------------------------------------------------------- */

describe('funding signal detection', () => {
  it('recognises rounds and amounts', () => {
    expect(detectFundingSignals('We just closed our Series B')).toContain('Series B');
    expect(detectFundingSignals('seed stage startup')).toContain('Seed');
    expect(detectFundingSignals('pre-seed company')).toContain('Pre-seed');
    expect(detectFundingSignals('raised $12M last year')).toEqual(
      expect.arrayContaining([expect.stringContaining('12')]),
    );
  });

  it('recognises accelerators and notable investors', () => {
    expect(detectFundingSignals('We are a YC W23 company')).toContain('Y Combinator');
    expect(detectFundingSignals('Backed by Sequoia')).toEqual(
      expect.arrayContaining([expect.stringContaining('Sequoia')]),
    );
  });

  it('finds nothing in text with no funding language', () => {
    expect(detectFundingSignals('We build accounting software.')).toEqual([]);
    expect(detectFundingSignals(null)).toEqual([]);
  });
});

describe('hiring signal detection', () => {
  it('recognises hiring and contract language', () => {
    const signals = detectHiringSignals('We are hiring a senior backend engineer, contract to hire, remote');
    expect(signals).toContain('Explicitly hiring');
    expect(signals).toContain('Hiring backend engineers');
    expect(signals).toContain('Hiring senior engineers');
    expect(signals).toContain('Open to contract work');
    expect(signals).toContain('Remote-friendly');
  });

  it('flags contract signals separately, since they matter most to a freelancer', () => {
    expect(hasContractSignal('open to fractional CTO work')).toBe(true);
    expect(hasContractSignal('full-time permanent role only')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Email extraction — the rule that must never regress                        */
/* -------------------------------------------------------------------------- */

describe('published email extraction', () => {
  it('extracts an address the poster wrote down', () => {
    expect(extractPublishedEmails('Apply at jobs@acme.io please')).toEqual(['jobs@acme.io']);
    expect(extractPublishedEmails('Contact: Dana Whitfield <dana@northwind.io>')).toEqual([
      'dana@northwind.io',
    ]);
  });

  it('skips role addresses that are never a useful outreach target', () => {
    expect(extractPublishedEmails('noreply@acme.io')).toEqual([]);
    expect(extractPublishedEmails('security@acme.io privacy@acme.io')).toEqual([]);
  });

  it('skips reserved documentation domains', () => {
    expect(extractPublishedEmails('someone@example.com')).toEqual([]);
    expect(extractPublishedEmails('someone@company.example')).toEqual([]);
  });

  it('returns nothing when no address was published', () => {
    // This is the case that matters: no address means the operator has to find
    // one. There is no code path anywhere that invents first.last@domain.
    expect(extractPublishedEmails('We are hiring! See our careers page.')).toEqual([]);
    expect(extractPublishedEmails(null)).toEqual([]);
  });

  it('normalises what it finds so dedup works', () => {
    expect(extractPublishedEmails('Mail John.Doe@Example.IO')).toEqual(['john.doe@example.io']);
  });
});

/* -------------------------------------------------------------------------- */
/* Candidate normalisation                                                    */
/* -------------------------------------------------------------------------- */

describe('normalizeCandidate', () => {
  const options = { profile: PROFILE, minMatchScore: 0 };

  it('builds a scored candidate from a raw item', () => {
    const outcome = normalizeCandidate(
      {
        companyName: 'Northwind Analytics, Inc.',
        website: 'https://northwind.io',
        locationText: 'Austin, TX',
        signalText: 'Series A. Hiring a backend engineer. Stack: TypeScript, PostgreSQL. jobs@northwind.io',
      },
      options,
    );

    expect(outcome.keep).toBe(true);
    const candidate = outcome.candidate!;
    expect(candidate.normalizedName).toBe('northwind analytics');
    expect(candidate.normalizedDomain).toBe('northwind.io');
    expect(candidate.country).toBe('US');
    expect(candidate.contactability).toBe('OPT_OUT_REGIME');
    expect(candidate.fundingSignals).toContain('Series A');
    expect(candidate.publishedEmail).toBe('jobs@northwind.io');
    expect(candidate.matchScore).toBeGreaterThan(0);
  });

  it('drops Indian companies', () => {
    const outcome = normalizeCandidate(
      { companyName: 'Acme Softech', locationText: 'Bengaluru, India', signalText: 'Hiring Java engineers' },
      options,
    );
    expect(outcome.keep).toBe(false);
    expect(outcome.reason).toContain('exclusion list');
  });

  it('drops candidates below the match threshold', () => {
    const outcome = normalizeCandidate(
      { companyName: 'Unrelated Co', locationText: 'Austin, TX', signalText: 'We sell insurance.' },
      { profile: PROFILE, minMatchScore: 40 },
    );
    expect(outcome.keep).toBe(false);
    expect(outcome.reason).toContain('below the threshold');
  });

  it('refuses a candidate with no usable company name', () => {
    expect(normalizeCandidate({ companyName: '   ' }, options).keep).toBe(false);
    expect(normalizeCandidate({ companyName: '!!!' }, options).keep).toBe(false);
  });

  it('never carries a dangerous URL through', () => {
    const outcome = normalizeCandidate(
      { companyName: 'Evil Co', website: 'javascript:alert(1)', locationText: 'Austin, TX' },
      options,
    );
    expect(outcome.candidate?.website).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Promotion gate                                                             */
/* -------------------------------------------------------------------------- */

describe('canPromote', () => {
  it('requires a contact address', () => {
    const result = canPromote({ contactability: 'OPT_OUT_REGIME', publishedEmail: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('never guesses');
  });

  it('accepts a manually supplied address when none was published', () => {
    const result = canPromote(
      { contactability: 'OPT_OUT_REGIME', publishedEmail: null },
      { contactEmail: 'cto@acme.io' },
    );
    expect(result.ok).toBe(true);
  });

  it('blocks a consent-required jurisdiction until acknowledged', () => {
    const blocked = canPromote({ contactability: 'CONSENT_REQUIRED', publishedEmail: 'a@b.io' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('consent-based');

    const acknowledged = canPromote(
      { contactability: 'CONSENT_REQUIRED', publishedEmail: 'a@b.io' },
      { acknowledgedConsentRisk: true },
    );
    expect(acknowledged.ok).toBe(true);
  });

  it('never permits an excluded country, acknowledged or not', () => {
    const result = canPromote(
      { contactability: 'EXCLUDED', publishedEmail: 'a@b.io' },
      { acknowledgedConsentRisk: true },
    );
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Hacker News parsing                                                        */
/* -------------------------------------------------------------------------- */

describe('Hacker News post parsing', () => {
  it('converts comment HTML to text', () => {
    const html =
      'Acme | SF | Backend<p>We use <i>Postgres</i>.<p>Email <a href="mailto:jobs@acme.io">jobs@acme.io</a>';
    const text = htmlToText(html);
    expect(text).toContain('Acme | SF | Backend');
    expect(text).toContain('Postgres');
    expect(text).not.toContain('<p>');
  });

  it('decodes HTML entities', () => {
    expect(htmlToText('R&amp;D team &quot;core&quot;')).toBe('R&D team "core"');
  });

  it('parses the conventional pipe-separated header', () => {
    const parsed = parseJobPost(
      'Northwind Analytics | Austin, TX | Senior Backend Engineer | REMOTE | $180k\nWe use Postgres.\nhttps://northwind.io',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.companyName).toBe('Northwind Analytics');
    expect(parsed?.locationText).toBe('Austin, TX');
    expect(parsed?.role).toContain('Backend Engineer');
    expect(parsed?.website).toBe('https://northwind.io');
  });

  it('prefers the company site over a job-board URL', () => {
    const parsed = parseJobPost(
      'Acme | SF | Engineer\nApply: https://boards.greenhouse.io/acme/jobs/1 or https://acme.io',
    );
    expect(parsed?.website).toBe('https://acme.io');
  });

  it('skips prose that is not a company header rather than inventing a name', () => {
    expect(parseJobPost('Hi everyone, we are a small team looking for help with our product')).toBeNull();
    expect(parseJobPost('We are hiring several people across the company this quarter')).toBeNull();
    expect(parseJobPost('')).toBeNull();
  });

  it('handles em-dash separated headers', () => {
    const parsed = parseJobPost('Cobalt Ledger — Brooklyn, NY — Backend Engineer\nDetails here.');
    expect(parsed?.companyName).toBe('Cobalt Ledger');
  });
});

/* -------------------------------------------------------------------------- */
/* GitHub query building                                                      */
/* -------------------------------------------------------------------------- */

describe('GitHub repository query', () => {
  it('builds qualifiers from configuration', () => {
    const query = buildRepoQuery({
      languages: ['TypeScript', 'Java'],
      topics: ['saas'],
      minStars: 100,
      pushedSince: '2025-01-01',
    });
    expect(query).toContain('language:TypeScript');
    expect(query).toContain('language:Java');
    expect(query).toContain('topic:saas');
    expect(query).toContain('stars:>=100');
    expect(query).toContain('pushed:>=2025-01-01');
  });

  it('excludes archived repositories and forks, which say nothing about current work', () => {
    const query = buildRepoQuery({});
    expect(query).toContain('archived:false');
    expect(query).toContain('fork:false');
  });
});

/* -------------------------------------------------------------------------- */
/* SEC EDGAR parsing                                                          */
/* -------------------------------------------------------------------------- */

describe('SEC master index parsing', () => {
  const INDEX = `Description:           Master Index of EDGAR Dissemination Feed
Last Data Received:    January 2, 2025

CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
1234567|NORTHWIND ANALYTICS INC|D|2025-01-02|edgar/data/1234567/0001234567-25-000001.txt
7654321|SOME REIT PARTNERS LP|D|2025-01-02|edgar/data/7654321/0007654321-25-000002.txt
1111111|BIG CORP|10-K|2025-01-02|edgar/data/1111111/0001111111-25-000003.txt
2222222|AMENDED CO|D/A|2025-01-02|edgar/data/2222222/0002222222-25-000004.txt`;

  it('extracts only the requested form types', () => {
    const entries = parseMasterIndex(INDEX, ['D', 'D/A']);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.formType)).toEqual(['D', 'D', 'D/A']);
    expect(entries[0]?.companyName).toBe('NORTHWIND ANALYTICS INC');
    expect(entries[0]?.cik).toBe('1234567');
  });

  it('skips the header and separator rows', () => {
    const entries = parseMasterIndex(INDEX, ['D']);
    expect(entries.every((e) => /^\d+$/.test(e.cik))).toBe(true);
  });

  it('returns nothing for an empty or malformed file', () => {
    expect(parseMasterIndex('', ['D'])).toEqual([]);
    expect(parseMasterIndex('garbage without pipes', ['D'])).toEqual([]);
  });
});

describe('EDGAR index paths', () => {
  it('maps a date to year, quarter, and compact form', () => {
    expect(indexPathFor(new Date('2025-01-02T00:00:00Z'))).toEqual({
      year: 2025,
      quarter: 'QTR1',
      compact: '20250102',
    });
    expect(indexPathFor(new Date('2025-08-16T00:00:00Z')).quarter).toBe('QTR3');
    expect(indexPathFor(new Date('2025-12-31T00:00:00Z')).quarter).toBe('QTR4');
  });

  it('walks back over business days only, since EDGAR publishes no weekend index', () => {
    // 2025-01-06 is a Monday.
    const days = recentBusinessDays(new Date('2025-01-06T00:00:00Z'), 3);
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2025-01-06',
      '2025-01-03',
      '2025-01-02',
    ]);
    expect(days.every((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* robots.txt                                                                 */
/* -------------------------------------------------------------------------- */

describe('robots.txt handling', () => {
  it('applies the wildcard group', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public', 'outreach/1');
    expect(isPathAllowed(rules, '/anything')).toBe(true);
    expect(isPathAllowed(rules, '/private/secret')).toBe(false);
    expect(isPathAllowed(rules, '/private/public/ok')).toBe(true);
  });

  it('prefers a group naming our agent over the wildcard', () => {
    const body = 'User-agent: *\nDisallow: /\n\nUser-agent: outreach-prospect-discovery\nDisallow: /admin';
    const rules = parseRobots(body, 'outreach-prospect-discovery/0.1 (+https://x)');
    expect(isPathAllowed(rules, '/public')).toBe(true);
    expect(isPathAllowed(rules, '/admin/panel')).toBe(false);
  });

  it('treats a blanket disallow as a disallow', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /', 'outreach/1');
    expect(isPathAllowed(rules, '/anything')).toBe(false);
  });

  it('treats an empty Disallow as permission, per the standard', () => {
    const rules = parseRobots('User-agent: *\nDisallow:', 'outreach/1');
    expect(isPathAllowed(rules, '/anything')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# a comment\n\nUser-agent: *\nDisallow: /x # trailing', 'outreach/1');
    expect(isPathAllowed(rules, '/x/y')).toBe(false);
    expect(isPathAllowed(rules, '/y')).toBe(true);
  });

  it('supports wildcard and end-anchored patterns', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$', 'outreach/1');
    expect(isPathAllowed(rules, '/docs/report.pdf')).toBe(false);
    expect(isPathAllowed(rules, '/docs/report.pdf.html')).toBe(true);
  });

  it('lets the longest match win when allow and disallow overlap', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b', 'outreach/1');
    expect(isPathAllowed(rules, '/a/b/c')).toBe(true);
    expect(isPathAllowed(rules, '/a/x')).toBe(false);
  });
});
