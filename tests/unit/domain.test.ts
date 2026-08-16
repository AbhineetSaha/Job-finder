import { describe, expect, it } from 'vitest';
import {
  emailDomain,
  isValidEmailShape,
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  safeUrl,
  splitName,
} from '../../src/domain/normalize.js';
import { buildDedupKeys, findDuplicate, findIntraBatchDuplicates } from '../../src/domain/dedup.js';
import {
  classifyBand,
  coerceSignals,
  emptySignals,
  resolveWeights,
  scoreProspect,
} from '../../src/domain/qualification.js';
import { categorizeRole, isDecisionMaker, rolePriority } from '../../src/domain/roles.js';
import {
  appendComplianceFooter,
  extractVariables,
  render,
  renderEmail,
} from '../../src/domain/template.js';
import { allowedTransitions, canTransition, isContactable, pipelineStage, statusAfterSend } from '../../src/domain/status.js';
import { checkRateLimits, nextSendDelaySeconds, retryDelaySeconds } from '../../src/domain/ratelimit.js';

describe('normalizeEmail', () => {
  it('treats case variants as the same address', () => {
    expect(normalizeEmail('John.Doe@Example.com')).toBe('john.doe@example.com');
    expect(normalizeEmail('john.doe@example.com')).toBe('john.doe@example.com');
    expect(normalizeEmail('  JOHN.DOE@EXAMPLE.COM  ')).toBe('john.doe@example.com');
  });

  it('strips sub-addressing so a plus tag cannot create a second identity', () => {
    expect(normalizeEmail('dev+leads@acme.com')).toBe('dev@acme.com');
    expect(normalizeEmail('dev+a+b@acme.com')).toBe('dev@acme.com');
  });

  it('ignores dots in the local part only for providers that ignore them', () => {
    expect(normalizeEmail('j.doe@gmail.com')).toBe('jdoe@gmail.com');
    // A dot IS significant almost everywhere else — collapsing it would merge
    // two different people.
    expect(normalizeEmail('j.doe@acme.com')).toBe('j.doe@acme.com');
  });

  it('preserves hyphens in domains', () => {
    expect(normalizeEmail('dev@my-company.co.uk')).toBe('dev@my-company.co.uk');
  });

  it('rejects malformed and injection-shaped addresses', () => {
    expect(normalizeEmail('bad@')).toBeNull();
    expect(normalizeEmail('@bad.com')).toBeNull();
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail('a b@c.com')).toBeNull();
    expect(normalizeEmail('victim@x.com\r\nBcc: attacker@evil.com')).toBeNull();
    expect(normalizeEmail('+only@x.com')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('reduces URLs and hostnames to a bare domain', () => {
    expect(normalizeDomain('https://WWW.Example.com/careers')).toBe('example.com');
    expect(normalizeDomain('Example.COM.')).toBe('example.com');
    expect(normalizeDomain('http://sub.example.com:8080/x')).toBe('sub.example.com');
    expect(normalizeDomain('example.com')).toBe('example.com');
  });

  it('rejects things that are not domains', () => {
    expect(normalizeDomain('nope')).toBeNull();
    expect(normalizeDomain('javascript:alert(1)')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });
});

describe('normalizeCompanyName', () => {
  it('collapses legal suffixes and punctuation', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
    expect(normalizeCompanyName('ACME Incorporated')).toBe('acme');
    expect(normalizeCompanyName('Acme LLC')).toBe('acme');
    expect(normalizeCompanyName('  Acme   Corp  Ltd ')).toBe('acme');
  });

  it('expands ampersands so "Foo & Bar" and "Foo and Bar" match', () => {
    expect(normalizeCompanyName('Foo & Bar Corp')).toBe('foo and bar');
    expect(normalizeCompanyName('Foo and Bar')).toBe('foo and bar');
  });

  it('does not erase a name that is only a suffix word', () => {
    expect(normalizeCompanyName('Group')).toBe('group');
  });
});

describe('splitName / safeUrl / emailDomain', () => {
  it('splits names without inventing missing parts', () => {
    expect(splitName('Jane Doe')).toEqual({ firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe' });
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: null, fullName: 'Cher' });
    expect(splitName('  Ana  Maria  Silva ')).toEqual({
      firstName: 'Ana',
      lastName: 'Maria Silva',
      fullName: 'Ana Maria Silva',
    });
    expect(splitName(null)).toEqual({ firstName: null, lastName: null, fullName: '' });
  });

  it('only allows http and https URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>x</script>')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('example.com')).toBe('https://example.com');
  });

  it('extracts the domain used for per-domain rate limiting', () => {
    expect(emailDomain('Dev+x@Example.COM')).toBe('example.com');
    expect(emailDomain('broken')).toBeNull();
  });
});

describe('deduplication', () => {
  const contactRecord = {
    contactId: 'c1',
    companyId: 'co1',
    normalizedEmail: 'john.doe@acme.com',
    normalizedContactName: 'john doe',
    companyNormalizedDomain: 'acme.com',
  };
  const companyRecord = { companyId: 'co1', normalizedName: 'acme', normalizedDomain: 'acme.com' };

  it('matches on normalised email regardless of formatting', () => {
    const decision = findDuplicate(
      { companyName: 'Acme', contactEmail: 'John.Doe@ACME.com' },
      { contacts: [contactRecord], companies: [companyRecord] },
    );
    expect(decision.kind).toBe('EMAIL');
    expect(decision.isDuplicateContact).toBe(true);
    expect(decision.existingContactId).toBe('c1');
  });

  it('matches the same person at the same domain under a different address', () => {
    const decision = findDuplicate(
      {
        companyName: 'Acme',
        companyDomainOrWebsite: 'acme.com',
        contactName: 'John Doe',
        contactEmail: 'jdoe@acme.com',
      },
      { contacts: [contactRecord], companies: [companyRecord] },
    );
    expect(decision.kind).toBe('DOMAIN_AND_CONTACT');
    expect(decision.isDuplicateContact).toBe(true);
  });

  it('reuses a known company for a genuinely new contact', () => {
    const decision = findDuplicate(
      {
        companyName: 'Acme',
        companyDomainOrWebsite: 'acme.com',
        contactName: 'Sara Klein',
        contactEmail: 'sara@acme.com',
      },
      { contacts: [contactRecord], companies: [companyRecord] },
    );
    expect(decision.kind).toBe('DOMAIN');
    expect(decision.isDuplicateContact).toBe(false);
    expect(decision.existingCompanyId).toBe('co1');
  });

  it('falls back to company name when no domain is known', () => {
    const decision = findDuplicate(
      { companyName: 'ACME, Inc.', contactName: 'New Person', contactEmail: 'new@other-domain.com' },
      { contacts: [], companies: [companyRecord] },
    );
    expect(decision.kind).toBe('COMPANY_NAME');
    expect(decision.existingCompanyId).toBe('co1');
  });

  it('reports no duplicate for a genuinely new company and contact', () => {
    const decision = findDuplicate(
      { companyName: 'Brand New Co', contactEmail: 'hi@brandnew.com' },
      { contacts: [], companies: [] },
    );
    expect(decision.kind).toBe('NONE');
  });

  it('derives the company domain from a work email when no website is given', () => {
    const keys = buildDedupKeys({ companyName: 'Acme', contactEmail: 'john@acme.com' });
    expect(keys.normalizedDomain).toBe('acme.com');
  });

  it('catches duplicates inside a single import batch', () => {
    const conflicts = findIntraBatchDuplicates([
      { companyName: 'A', contactEmail: 'john.doe@a.com', contactName: 'John Doe' },
      { companyName: 'A', contactEmail: 'John.Doe@A.com', contactName: 'John Doe' },
      { companyName: 'B', contactEmail: 'other@b.com', contactName: 'Other Person' },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.index).toBe(1);
    expect(conflicts[0]?.duplicateOfIndex).toBe(0);
  });
});

describe('qualification scoring', () => {
  it('produces the maximum score when every signal is YES', () => {
    const signals = coerceSignals({
      usCompany: 'YES',
      saasOrSoftware: 'YES',
      engineeringTeamIdentified: 'YES',
      hiringEngineers: 'YES',
      contractorSignal: 'YES',
      technologyMatch: 'YES',
      engineeringNeed: 'YES',
      decisionMakerIdentified: 'YES',
    });
    const result = scoreProspect(signals);
    expect(result.score).toBe(100);
    expect(result.band).toBe('HIGH_PRIORITY');
    expect(result.unknownSignals).toEqual([]);
  });

  it('scores UNKNOWN as zero and records it as unknown, never as a guess', () => {
    const signals = emptySignals();
    const result = scoreProspect(signals);
    expect(result.score).toBe(0);
    expect(result.band).toBe('POOR');
    expect(result.unknownSignals).toHaveLength(8);
    expect(result.reasons.every((r) => r.points === 0)).toBe(true);
  });

  it('distinguishes a NO finding from an UNKNOWN gap', () => {
    const result = scoreProspect(
      coerceSignals({ usCompany: 'NO', saasOrSoftware: 'UNKNOWN' }),
    );
    expect(result.unknownSignals).toContain('saasOrSoftware');
    expect(result.unknownSignals).not.toContain('usCompany');
  });

  it('reproduces the worked example from the brief', () => {
    const result = scoreProspect(
      coerceSignals({
        usCompany: 'YES',
        saasOrSoftware: 'YES',
        engineeringTeamIdentified: 'YES',
        hiringEngineers: 'YES',
        contractorSignal: 'NO',
        technologyMatch: 'YES',
        engineeringNeed: 'YES',
        decisionMakerIdentified: 'YES',
      }),
    );
    expect(result.score).toBe(85);
    expect(result.band).toBe('STRONG');
  });

  it('applies configured weights and ignores corrupt ones', () => {
    const weights = resolveWeights({ usCompany: 30, saasOrSoftware: 'nonsense', missingKey: 5, hiringEngineers: -4 });
    expect(weights.usCompany).toBe(30);
    expect(weights.saasOrSoftware).toBe(15);
    expect(weights.hiringEngineers).toBe(15);
  });

  it('clamps a score built from oversized custom weights', () => {
    const result = scoreProspect(
      coerceSignals({ usCompany: 'YES', saasOrSoftware: 'YES' }),
      { usCompany: 900, saasOrSoftware: 900 },
    );
    expect(result.score).toBe(100);
  });

  it('treats unrecognised signal values as UNKNOWN rather than truthy', () => {
    const signals = coerceSignals({ usCompany: 'yes', saasOrSoftware: true, hiringEngineers: 1 });
    expect(signals.usCompany).toBe('UNKNOWN');
    expect(signals.saasOrSoftware).toBe('UNKNOWN');
    expect(signals.hiringEngineers).toBe('UNKNOWN');
  });

  it('maps scores onto the documented bands', () => {
    expect(classifyBand(100)).toBe('HIGH_PRIORITY');
    expect(classifyBand(90)).toBe('HIGH_PRIORITY');
    expect(classifyBand(89)).toBe('STRONG');
    expect(classifyBand(75)).toBe('STRONG');
    expect(classifyBand(74)).toBe('POTENTIAL');
    expect(classifyBand(60)).toBe('POTENTIAL');
    expect(classifyBand(59)).toBe('WEAK');
    expect(classifyBand(40)).toBe('WEAK');
    expect(classifyBand(39)).toBe('POOR');
    expect(classifyBand(0)).toBe('POOR');
  });
});

describe('role categorisation', () => {
  it('prefers the most specific match', () => {
    expect(categorizeRole('Co-Founder & CTO')).toBe('CO_FOUNDER');
    expect(categorizeRole('CTO')).toBe('CTO');
    expect(categorizeRole('Founder')).toBe('FOUNDER');
    expect(categorizeRole('VP of Engineering')).toBe('VP_ENGINEERING');
    expect(categorizeRole('Head of Engineering')).toBe('HEAD_OF_ENGINEERING');
    expect(categorizeRole('Engineering Manager')).toBe('ENGINEERING_MANAGER');
    expect(categorizeRole('Chief Technology Officer')).toBe('CTO');
  });

  it('returns UNKNOWN rather than guessing for empty input', () => {
    expect(categorizeRole(null)).toBe('UNKNOWN');
    expect(categorizeRole('')).toBe('UNKNOWN');
    expect(categorizeRole('   ')).toBe('UNKNOWN');
  });

  it('returns OTHER for roles that are not decision makers', () => {
    expect(categorizeRole('Marketing Intern')).toBe('OTHER');
    expect(isDecisionMaker(categorizeRole('Marketing Intern'))).toBe(false);
    expect(isDecisionMaker(categorizeRole('CTO'))).toBe(true);
  });

  it('orders the review queue by seniority', () => {
    expect(rolePriority('FOUNDER')).toBeLessThan(rolePriority('CTO'));
    expect(rolePriority('CTO')).toBeLessThan(rolePriority('ENGINEERING_MANAGER'));
    expect(rolePriority('ENGINEERING_MANAGER')).toBeLessThan(rolePriority('UNKNOWN'));
  });
});

describe('template rendering', () => {
  it('interpolates supplied values', () => {
    const result = render('Hi {{first_name}} at {{company_name}}', {
      first_name: 'Dana',
      company_name: 'Northwind',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('Hi Dana at Northwind');
      expect(result.used).toEqual({ first_name: 'Dana', company_name: 'Northwind' });
    }
  });

  it('FAILS on a missing variable rather than emitting a blank', () => {
    const result = render('I noticed {{specific_observation}}.', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(['specific_observation']);
  });

  it('treats a whitespace-only value as missing', () => {
    const result = render('I noticed {{specific_observation}}.', { specific_observation: '   ' });
    expect(result.ok).toBe(false);
  });

  it('rejects variables outside the known set', () => {
    const result = render('Hello {{arbitrary_thing}}', { arbitrary_thing: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unknown).toEqual(['arbitrary_thing']);
  });

  it('reports malformed placeholders instead of silently leaving them in', () => {
    const result = render('Hi {{ first name }}', { first_name: 'Dana' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.malformed.length).toBeGreaterThan(0);
  });

  it('extracts referenced variables in order without duplicates', () => {
    expect(extractVariables('{{a_b}} {{c_d}} {{a_b}}')).toEqual(['a_b', 'c_d']);
  });

  it('never renders a partial email — subject failure blocks the body', () => {
    const result = renderEmail('{{company_name}} intro', 'Hi {{first_name}}', { first_name: 'Dana' });
    expect(result.ok).toBe(false);
  });

  it('rejects a subject containing a line break (header injection)', () => {
    const result = renderEmail('Hi {{first_name}}', 'Body', { first_name: 'Dana\r\nBcc: x@y.com' });
    expect(result.ok).toBe(false);
  });

  it('appends the compliance footer with address and unsubscribe link', () => {
    const body = appendComplianceFooter('Hello there.', {
      senderName: 'Sam Operator',
      senderEmail: 'sam@example.com',
      postalAddress: '1 Example St, Springfield IL',
      unsubscribeUrl: 'https://app.example.com/unsubscribe/abc',
    });
    expect(body).toContain('Sam Operator');
    expect(body).toContain('1 Example St, Springfield IL');
    expect(body).toContain('https://app.example.com/unsubscribe/abc');
    expect(body).toContain('Unsubscribe');
  });
});

describe('prospect status machine', () => {
  it('permits the documented forward path', () => {
    expect(canTransition('DISCOVERED', 'RESEARCHING').allowed).toBe(true);
    expect(canTransition('RESEARCHING', 'QUALIFIED').allowed).toBe(true);
    expect(canTransition('QUALIFIED', 'READY_FOR_REVIEW').allowed).toBe(true);
    expect(canTransition('READY_FOR_REVIEW', 'APPROVED').allowed).toBe(true);
    expect(canTransition('APPROVED', 'CONTACTED').allowed).toBe(true);
  });

  it('rejects skipping the approval stage', () => {
    expect(canTransition('DISCOVERED', 'CONTACTED').allowed).toBe(false);
    expect(canTransition('QUALIFIED', 'CONTACTED').allowed).toBe(false);
  });

  it('allows outcome statuses from anywhere', () => {
    expect(canTransition('DISCOVERED', 'NOT_INTERESTED').allowed).toBe(true);
    expect(canTransition('FOLLOW_UP_2', 'DO_NOT_CONTACT').allowed).toBe(true);
    expect(canTransition('CONTACTED', 'BOUNCED').allowed).toBe(true);
  });

  it('makes DO_NOT_CONTACT a one-way door', () => {
    expect(canTransition('DO_NOT_CONTACT', 'RESEARCHING').allowed).toBe(false);
    expect(canTransition('DO_NOT_CONTACT', 'QUALIFIED').allowed).toBe(false);
    expect(allowedTransitions('DO_NOT_CONTACT')).toEqual([]);
  });

  it('blocks further contact from terminal statuses', () => {
    expect(isContactable('DO_NOT_CONTACT')).toBe(false);
    expect(isContactable('NOT_INTERESTED')).toBe(false);
    expect(isContactable('BOUNCED')).toBe(false);
    expect(isContactable('INVALID')).toBe(false);
    expect(isContactable('WON')).toBe(false);
    expect(isContactable('QUALIFIED')).toBe(true);
  });

  it('advances through the contacted statuses by sequence position', () => {
    expect(statusAfterSend(0)).toBe('CONTACTED');
    expect(statusAfterSend(1)).toBe('FOLLOW_UP_1');
    expect(statusAfterSend(2)).toBe('FOLLOW_UP_2');
    expect(statusAfterSend(9)).toBe('FOLLOW_UP_2');
  });

  it('collapses detailed statuses onto the pipeline board', () => {
    expect(pipelineStage('DISCOVERED')).toBe('NEW');
    expect(pipelineStage('FOLLOW_UP_2')).toBe('CONTACTED');
    expect(pipelineStage('MEETING_BOOKED')).toBe('MEETING');
    expect(pipelineStage('NOT_INTERESTED')).toBe('LOST');
    expect(pipelineStage('WON')).toBe('WON');
  });
});

describe('rate limiting', () => {
  const config = {
    dailyLimit: 20,
    hourlyLimit: 5,
    perDomainDailyLimit: 2,
    minDelaySeconds: 60,
    maxDelaySeconds: 120,
  };
  const now = new Date('2025-06-02T15:00:00Z');

  it('allows a send within every limit', () => {
    const result = checkRateLimits(
      config,
      { sentToday: 3, sentLastHour: 1, sentToDomainToday: 0, lastSentAt: null },
      now,
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks at the daily limit', () => {
    const result = checkRateLimits(
      config,
      { sentToday: 20, sentLastHour: 0, sentToDomainToday: 0, lastSentAt: null },
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('DAILY_LIMIT_REACHED');
  });

  it('blocks at the hourly limit', () => {
    const result = checkRateLimits(
      config,
      { sentToday: 5, sentLastHour: 5, sentToDomainToday: 0, lastSentAt: null },
      now,
    );
    expect(result.reason).toBe('HOURLY_LIMIT_REACHED');
  });

  it('blocks at the per-domain limit', () => {
    const result = checkRateLimits(
      config,
      { sentToday: 5, sentLastHour: 1, sentToDomainToday: 2, lastSentAt: null },
      now,
    );
    expect(result.reason).toBe('DOMAIN_LIMIT_REACHED');
  });

  it('enforces minimum spacing between sends', () => {
    const result = checkRateLimits(
      config,
      {
        sentToday: 1,
        sentLastHour: 1,
        sentToDomainToday: 0,
        lastSentAt: new Date(now.getTime() - 30_000),
      },
      now,
    );
    expect(result.reason).toBe('MIN_DELAY_NOT_ELAPSED');
    expect(result.retryAfter).not.toBeNull();
  });

  it('reads a limit of zero as "no sends", not "unlimited"', () => {
    const result = checkRateLimits(
      { ...config, dailyLimit: 0 },
      { sentToday: 0, sentLastHour: 0, sentToDomainToday: 0, lastSentAt: null },
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('DAILY_LIMIT_REACHED');
  });

  it('produces a delay inside the configured band', () => {
    for (const r of [0, 0.5, 0.999]) {
      const delay = nextSendDelaySeconds(config, () => r);
      expect(delay).toBeGreaterThanOrEqual(60);
      expect(delay).toBeLessThanOrEqual(120);
    }
  });

  it('backs off exponentially, capped, with jitter', () => {
    expect(retryDelaySeconds(1, { baseSeconds: 30, maxSeconds: 3600 }, () => 1)).toBeLessThanOrEqual(30);
    expect(retryDelaySeconds(5, { baseSeconds: 30, maxSeconds: 3600 }, () => 1)).toBeLessThanOrEqual(480);
    expect(retryDelaySeconds(20, { baseSeconds: 30, maxSeconds: 3600 }, () => 1)).toBeLessThanOrEqual(3600);
    expect(retryDelaySeconds(3, {}, () => 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('email shape validation', () => {
  it('accepts real-looking addresses and rejects injection attempts', () => {
    expect(isValidEmailShape('dana@northwind.example')).toBe(true);
    expect(isValidEmailShape('a@b')).toBe(false);
    expect(isValidEmailShape('x@y.com\nBcc: z@w.com')).toBe(false);
    expect(isValidEmailShape(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});
