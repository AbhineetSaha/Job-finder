/**
 * Development seed data.
 *
 * Every company, person, and email address below is invented. Domains use
 * `.example` / `example.com`, which are reserved by RFC 2606 and can never be
 * registered, so a misconfigured run cannot reach a real mailbox
 * (brief §61: "Do not use real people's personal data in seed data").
 *
 * Refuses to run when EMAIL_MODE=production.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from './client.js';
import { campaignMembers, campaigns, campaignSteps, deals, meetings, templates, userProfiles } from './schema.js';
import { getEnv } from '../lib/env.js';
import { createUser } from '../services/users.js';
import { createProspect } from '../services/prospects.js';
import { qualifyProspect } from '../services/qualification.js';
import { saveResearch } from '../services/research.js';
import { createCampaign, enrollProspects } from '../services/campaigns.js';
import { createDraft } from '../services/drafts.js';
import { upsertDeal } from '../services/crm.js';
import { recordManualReply } from '../services/events.js';
import { DEFAULT_SEND_DAYS, DEFAULT_SENDING_WINDOWS, DEFAULT_SEQUENCE } from '../services/defaults.js';

const SEED_EMAIL = 'operator@example.com';
const SEED_PASSWORD = 'development-password-change-me';

interface SeedCompany {
  companyName: string;
  website: string;
  contactName: string;
  contactRole: string;
  contactEmail: string;
  industry: string;
  companySize: string;
  fundingStage: string;
  city: string;
  state: string;
  timezone: string;
  description: string;
  technologyStack: string[];
  sourceUrl: string;
}

const SEED_COMPANIES: SeedCompany[] = [
  {
    companyName: 'Northwind Analytics',
    website: 'https://northwind-analytics.example',
    contactName: 'Dana Whitfield',
    contactRole: 'CTO',
    contactEmail: 'dana.whitfield@northwind-analytics.example',
    industry: 'SaaS — Analytics',
    companySize: '11-50',
    fundingStage: 'Series A',
    city: 'Austin',
    state: 'TX',
    timezone: 'America/Chicago',
    description: 'Fictional product analytics platform for e-commerce teams.',
    technologyStack: ['TypeScript', 'React', 'PostgreSQL', 'Node.js'],
    sourceUrl: 'https://northwind-analytics.example/careers',
  },
  {
    companyName: 'Cobalt Ledger, Inc.',
    website: 'https://cobaltledger.example',
    contactName: 'Marcus Oyelaran',
    contactRole: 'Co-founder & CTO',
    contactEmail: 'marcus@cobaltledger.example',
    industry: 'FinTech SaaS',
    companySize: '11-50',
    fundingStage: 'Seed',
    city: 'Brooklyn',
    state: 'NY',
    timezone: 'America/New_York',
    description: 'Fictional reconciliation tooling for small finance teams.',
    technologyStack: ['Java', 'Spring Boot', 'PostgreSQL'],
    sourceUrl: 'https://cobaltledger.example/engineering',
  },
  {
    companyName: 'Meridian Health Systems',
    website: 'https://meridianhealth.example',
    contactName: 'Priya Raghunathan',
    contactRole: 'VP of Engineering',
    contactEmail: 'praghunathan@meridianhealth.example',
    industry: 'Health SaaS',
    companySize: '51-200',
    fundingStage: 'Series B',
    city: 'Denver',
    state: 'CO',
    timezone: 'America/Denver',
    description: 'Fictional scheduling platform for outpatient clinics.',
    technologyStack: ['TypeScript', 'Next.js', 'PostgreSQL', 'Supabase'],
    sourceUrl: 'https://meridianhealth.example/about/engineering',
  },
  {
    companyName: 'Tidepool Commerce LLC',
    website: 'https://tidepoolcommerce.example',
    contactName: 'Alex Brennan',
    contactRole: 'Founder',
    contactEmail: 'alex@tidepoolcommerce.example',
    industry: 'E-commerce SaaS',
    companySize: '1-10',
    fundingStage: 'Bootstrapped',
    city: 'Portland',
    state: 'OR',
    timezone: 'America/Los_Angeles',
    description: 'Fictional headless storefront toolkit.',
    technologyStack: ['Next.js', 'React', 'Drizzle ORM', 'PostgreSQL'],
    sourceUrl: 'https://tidepoolcommerce.example/blog/scaling-checkout',
  },
  {
    companyName: 'Ironvale Logistics',
    website: 'https://ironvale.example',
    contactName: 'Sofia Lindqvist',
    contactRole: 'Head of Engineering',
    contactEmail: 'sofia.lindqvist@ironvale.example',
    industry: 'Logistics Software',
    companySize: '51-200',
    fundingStage: 'Series A',
    city: 'Chicago',
    state: 'IL',
    timezone: 'America/Chicago',
    description: 'Fictional freight visibility platform.',
    technologyStack: ['Java', 'Spring Boot', 'PostgreSQL', 'React'],
    sourceUrl: 'https://ironvale.example/jobs/senior-backend-engineer',
  },
  {
    companyName: 'Quillfeather Media',
    website: 'https://quillfeather.example',
    contactName: 'Tomas Reyes',
    contactRole: 'Engineering Manager',
    contactEmail: 'treyes@quillfeather.example',
    industry: 'Publishing / CMS',
    companySize: '11-50',
    fundingStage: 'Bootstrapped',
    city: 'Nashville',
    state: 'TN',
    timezone: 'America/Chicago',
    description: 'Fictional digital publishing network running a custom CMS.',
    technologyStack: ['Next.js', 'TypeScript', 'PostgreSQL'],
    sourceUrl: 'https://quillfeather.example/tech',
  },
  {
    companyName: 'Basalt Robotics Corp',
    website: 'https://basaltrobotics.example',
    contactName: 'Nadia Cheng',
    contactRole: 'Director of Software Engineering',
    contactEmail: 'nadia.cheng@basaltrobotics.example',
    industry: 'Industrial Software',
    companySize: '51-200',
    fundingStage: 'Series B',
    city: 'Pittsburgh',
    state: 'PA',
    timezone: 'America/New_York',
    description: 'Fictional warehouse automation software vendor.',
    technologyStack: ['Java', 'PostgreSQL', 'TypeScript'],
    sourceUrl: 'https://basaltrobotics.example/careers',
  },
  {
    companyName: 'Harborline Studios',
    website: 'https://harborlinestudios.example',
    contactName: 'Jules Amara',
    contactRole: 'Technical Director',
    contactEmail: 'jules@harborlinestudios.example',
    industry: 'Agency',
    companySize: '11-50',
    fundingStage: 'Bootstrapped',
    city: 'Boston',
    state: 'MA',
    timezone: 'America/New_York',
    description: 'Fictional product agency that takes on contract engineers.',
    technologyStack: ['React', 'Node.js', 'PostgreSQL'],
    sourceUrl: 'https://harborlinestudios.example/contact',
  },
  {
    companyName: 'Vellum Labs',
    website: 'https://vellumlabs.example',
    contactName: 'Ruth Okonkwo',
    contactRole: 'Founder & CEO',
    contactEmail: 'ruth@vellumlabs.example',
    industry: 'Developer Tools',
    companySize: '1-10',
    fundingStage: 'Pre-seed',
    city: 'Seattle',
    state: 'WA',
    timezone: 'America/Los_Angeles',
    description: 'Fictional documentation tooling startup.',
    technologyStack: ['TypeScript', 'Next.js', 'Supabase'],
    sourceUrl: 'https://vellumlabs.example/about',
  },
  {
    companyName: 'Copperfield Retail Group',
    website: 'https://copperfieldretail.example',
    contactName: 'Evan Statham',
    contactRole: 'Product Manager',
    contactEmail: 'evan.statham@copperfieldretail.example',
    industry: 'Retail Technology',
    companySize: '201-500',
    fundingStage: 'Private',
    city: 'Atlanta',
    state: 'GA',
    timezone: 'America/New_York',
    description: 'Fictional retail chain with an in-house engineering team.',
    technologyStack: ['Java', 'PostgreSQL'],
    sourceUrl: 'https://copperfieldretail.example/technology',
  },
];

async function seed(): Promise<void> {
  const env = getEnv();

  if (env.EMAIL_MODE === 'production') {
    throw new Error(
      'Refusing to seed while EMAIL_MODE=production. Seeding is a development-only operation.',
    );
  }

  const db = getDb();

  const userResult = await createUser({
    email: SEED_EMAIL,
    password: SEED_PASSWORD,
    name: 'Development Operator',
  });

  if (!userResult.ok) {
    // eslint-disable-next-line no-console
    console.log(`Seed user already exists or could not be created: ${userResult.error}`);
    // eslint-disable-next-line no-console
    console.log('Nothing to do. Run `npm run db:reset` first for a clean seed.');
    return;
  }

  const userId = userResult.user.id;

  await db
    .update(userProfiles)
    .set({
      title: 'Software Engineer — Backend, SaaS, PostgreSQL',
      bio: 'Independent software engineer helping US startups and product teams build, improve, and maintain production software.',
      location: 'Remote (US clients)',
      timezone: 'America/New_York',
      phone: '',
      portfolioUrl: 'https://example.com/portfolio',
      githubUrl: 'https://github.com/example',
      skills: ['Java', 'Spring Boot', 'TypeScript', 'Node.js', 'React', 'Next.js', 'PostgreSQL', 'Drizzle ORM'],
      industries: ['SaaS', 'FinTech', 'Health Tech', 'Developer Tools'],
      hourlyRate: '125.00',
      minimumProjectValue: '5000.00',
      availability: '20 hours/week',
    })
    .where(eq(userProfiles.userId, userId));

  // A postal address is required before any campaign can run, so the seed
  // supplies an obviously fictional one.
  const { settings } = await import('./schema.js');
  await db
    .update(settings)
    .set({
      postalAddress: '100 Example Street, Suite 200, Springfield, IL 62701, USA (FICTIONAL — replace before real use)',
      advertisingDisclosure: '',
    })
    .where(eq(settings.userId, userId));

  const created: { prospectId: string; company: SeedCompany }[] = [];

  for (const company of SEED_COMPANIES) {
    const result = await createProspect({
      userId,
      source: 'SEED',
      companyName: company.companyName,
      website: company.website,
      contactName: company.contactName,
      contactRole: company.contactRole,
      contactEmail: company.contactEmail,
      contactReason: 'Technical decision maker named on the public engineering page.',
      sourceUrl: company.sourceUrl,
      country: 'US',
      state: company.state,
      city: company.city,
      timezone: company.timezone,
      industry: company.industry,
      companySize: company.companySize,
      fundingStage: company.fundingStage,
      companyDescription: company.description,
      technologyStack: company.technologyStack,
    });

    if (result.ok) created.push({ prospectId: result.prospect.id, company });
  }

  // Qualify five of them to varying scores so the bands are all represented.
  const signalSets = [
    { usCompany: 'YES', saasOrSoftware: 'YES', engineeringTeamIdentified: 'YES', hiringEngineers: 'YES', contractorSignal: 'YES', technologyMatch: 'YES', engineeringNeed: 'YES', decisionMakerIdentified: 'YES' },
    { usCompany: 'YES', saasOrSoftware: 'YES', engineeringTeamIdentified: 'YES', hiringEngineers: 'YES', contractorSignal: 'NO', technologyMatch: 'YES', engineeringNeed: 'YES', decisionMakerIdentified: 'YES' },
    { usCompany: 'YES', saasOrSoftware: 'YES', engineeringTeamIdentified: 'YES', hiringEngineers: 'UNKNOWN', contractorSignal: 'UNKNOWN', technologyMatch: 'YES', engineeringNeed: 'YES', decisionMakerIdentified: 'YES' },
    { usCompany: 'YES', saasOrSoftware: 'YES', engineeringTeamIdentified: 'UNKNOWN', hiringEngineers: 'UNKNOWN', contractorSignal: 'UNKNOWN', technologyMatch: 'YES', engineeringNeed: 'UNKNOWN', decisionMakerIdentified: 'YES' },
    { usCompany: 'YES', saasOrSoftware: 'NO', engineeringTeamIdentified: 'UNKNOWN', hiringEngineers: 'NO', contractorSignal: 'UNKNOWN', technologyMatch: 'UNKNOWN', engineeringNeed: 'UNKNOWN', decisionMakerIdentified: 'NO' },
  ];

  for (let i = 0; i < Math.min(5, created.length); i += 1) {
    const entry = created[i];
    const signals = signalSets[i];
    if (!entry || !signals) continue;

    await qualifyProspect(userId, entry.prospectId, signals);

    await saveResearch({
      userId,
      prospectId: entry.prospectId,
      fields: {
        companyDescription: entry.company.description,
        product: `${entry.company.companyName}'s primary product (fictional seed data).`,
        targetCustomers: 'Small and mid-sized US teams.',
        technologyStack: entry.company.technologyStack.join(', '),
        engineeringTeamSize: `Around ${entry.company.companySize} employees overall.`,
        hiringActivity: i < 2 ? 'Open backend engineering role posted.' : 'No current postings found.',
        recentProductActivity: 'Recent public changelog entry (fictional).',
        potentialPainPoint: 'Backend throughput and migration safety as the data set grows.',
        whyRelevant: 'Their stack overlaps directly with my primary technologies.',
        whyContactingThem: `${entry.company.contactName} is the named technical decision maker.`,
        reasonForReachingOutNow: 'Their public hiring and changelog activity suggests active engineering investment.',
      },
      sources: [
        { field: 'companyDescription', url: entry.company.website, title: 'Company site' },
        { field: 'hiringActivity', url: entry.company.sourceUrl, title: 'Careers / engineering page' },
      ],
    });
  }

  const templateRows = await db.select().from(templates).where(eq(templates.userId, userId));
  const byKind = (kind: string, index = 0) => templateRows.filter((t) => t.kind === kind)[index];

  const initial = byKind('INITIAL');
  const followUp1 = byKind('FOLLOW_UP', 0);
  const followUp2 = byKind('FOLLOW_UP', 1);
  const final = byKind('FINAL');

  if (!initial || !followUp1 || !followUp2 || !final) {
    throw new Error('Default templates were not created.');
  }

  const stepTemplates = [initial.id, followUp1.id, followUp2.id, final.id];

  const campaignA = await createCampaign({
    userId,
    name: 'Q3 — Backend engineering, US SaaS',
    description: 'Seed campaign targeting US SaaS companies with visible backend hiring.',
    timezone: 'America/New_York',
    sendingWindows: DEFAULT_SENDING_WINDOWS,
    sendDays: DEFAULT_SEND_DAYS,
    steps: DEFAULT_SEQUENCE.map((step) => ({
      delayDays: step.delayDays,
      templateId: stepTemplates[step.templateIndex] as string,
    })),
  });

  const campaignB = await createCampaign({
    userId,
    name: 'Q3 — PostgreSQL performance, small teams',
    description: 'Seed campaign focused on database engineering.',
    timezone: 'America/Chicago',
    sendingWindows: [{ start: '10:00', end: '12:00' }],
    sendDays: [2, 3, 4],
    steps: [
      { delayDays: 0, templateId: initial.id },
      { delayDays: 5, templateId: followUp1.id },
    ],
  });

  if (campaignA.ok && created.length >= 3) {
    await enrollProspects(
      userId,
      campaignA.campaign.id,
      created.slice(0, 3).map((c) => c.prospectId),
    );

    // One draft awaiting approval, so the review queue is not empty on first run.
    const first = created[0];
    if (first) {
      const memberRows = await db
        .select()
        .from(campaignMembers)
        .where(eq(campaignMembers.prospectId, first.prospectId))
        .limit(1);

      const stepRows = await db
        .select()
        .from(campaignSteps)
        .where(eq(campaignSteps.campaignId, campaignA.campaign.id))
        .orderBy(campaignSteps.position);

      await createDraft({
        userId,
        prospectId: first.prospectId,
        templateId: initial.id,
        personalization: {
          specificObservation: 'you published a changelog entry about rebuilding your ingestion pipeline',
          engineeringSignal: 'an open senior backend engineering role',
          painPoint: 'keeping query latency stable as the events table grows',
          whyRelevant: 'I spend most of my time on exactly this kind of PostgreSQL and backend work',
          specificOffer: 'a fixed-scope review of your slowest queries with a written remediation plan',
          relevantTechnology: 'PostgreSQL',
        },
        campaignMemberId: memberRows[0]?.id ?? null,
        campaignStepId: stepRows[0]?.id ?? null,
      });
    }
  }

  if (campaignB.ok && created.length >= 5) {
    await enrollProspects(userId, campaignB.campaign.id, [created[4]!.prospectId]);
  }

  // A replied prospect with a deal and a meeting, so the CRM views have content.
  const repliedEntry = created[1];
  if (repliedEntry) {
    await recordManualReply({
      userId,
      prospectId: repliedEntry.prospectId,
      subject: 'Re: Cobalt Ledger — Backend Engineering',
      bodyText: 'Thanks for reaching out — we do have some reconciliation performance work coming up. Can you send over availability?',
      classification: 'INTERESTED',
    });

    await upsertDeal({
      userId,
      prospectId: repliedEntry.prospectId,
      estimatedValue: '18000.00',
      currency: 'USD',
      contractType: 'FIXED',
      estimatedHours: 144,
      hourlyRate: '125.00',
      proposalDate: new Date(),
      expectedCloseDate: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000),
      notes: 'Fictional seed deal.',
    });

    await db.insert(meetings).values({
      userId,
      prospectId: repliedEntry.prospectId,
      scheduledFor: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      timezone: 'America/New_York',
      meetingUrl: 'https://example.com/meet/fictional',
      notes: 'Discovery call — fictional seed data.',
      status: 'SCHEDULED',
    });
  }

  const openDeals = await db.select().from(deals).where(eq(deals.userId, userId));

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      'Seed complete.',
      '',
      `  Login:     ${SEED_EMAIL}`,
      `  Password:  ${SEED_PASSWORD}`,
      '',
      `  Companies: ${created.length}`,
      `  Contacts:  ${created.length}`,
      `  Qualified: ${Math.min(5, created.length)}`,
      `  Campaigns: ${[campaignA.ok, campaignB.ok].filter(Boolean).length}`,
      `  Templates: ${templateRows.length}`,
      `  Deals:     ${openDeals.length}`,
      '',
      '  All companies, people, and addresses are fictional and use RFC 2606',
      '  reserved domains, which can never be registered.',
      '',
      `  EMAIL_MODE=${env.EMAIL_MODE} — no real email can be sent.`,
      '',
    ].join('\n'),
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isMain) {
  seed()
    .then(closeDb)
    .catch(async (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', error);
      await closeDb();
      process.exit(1);
    });
}

export { seed, SEED_EMAIL, SEED_PASSWORD };
