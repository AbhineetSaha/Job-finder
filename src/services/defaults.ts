/**
 * Default offering and email templates created for a new account.
 *
 * These are seed *data*, not constants the application reads at runtime — the
 * operator edits them in the UI and nothing else references them. The default
 * sequence timing lives in `campaign_steps` rows for the same reason
 * (brief §26: "Do not hard-code these values").
 */

export interface DefaultService {
  key: string;
  name: string;
  description: string;
  bullets: string[];
  technologies: string[];
}

/** The five offerings from brief §16. */
export const DEFAULT_SERVICES: DefaultService[] = [
  {
    key: 'backend-engineering',
    name: 'Backend Engineering',
    description: 'APIs, backend features, and the data layer underneath them.',
    bullets: [
      'API design and implementation',
      'Backend features against an existing codebase',
      'Database integration',
      'Authentication and authorization',
      'Performance work',
      'Ongoing maintenance',
    ],
    technologies: ['Java', 'Spring Boot', 'Node.js', 'TypeScript', 'PostgreSQL'],
  },
  {
    key: 'saas-engineering',
    name: 'SaaS Engineering',
    description: 'Building and improving multi-tenant product software.',
    bullets: [
      'New product features',
      'Improvements to an existing product',
      'Admin and internal tooling',
      'Multi-tenant functionality',
      'Third-party integrations',
    ],
    technologies: ['TypeScript', 'React', 'Next.js', 'Node.js', 'PostgreSQL', 'Supabase'],
  },
  {
    key: 'cms-engineering',
    name: 'CMS Engineering',
    description: 'Content and publishing systems, including the editorial side.',
    bullets: [
      'CMS development',
      'Publishing systems',
      'Content workflows',
      'Rendering and delivery',
      'Editorial tooling',
    ],
    technologies: ['Next.js', 'React', 'TypeScript', 'PostgreSQL', 'Drizzle ORM'],
  },
  {
    key: 'database-engineering',
    name: 'Database Engineering',
    description: 'PostgreSQL work: schema, migrations, and query performance.',
    bullets: [
      'PostgreSQL schema design',
      'Safe migrations against live data',
      'Query optimisation',
      'Indexing strategy',
      'Performance investigation',
    ],
    technologies: ['PostgreSQL', 'SQL', 'Drizzle ORM', 'Supabase'],
  },
  {
    key: 'production-engineering',
    name: 'Production Engineering',
    description: 'Making existing software more reliable and easier to change.',
    bullets: [
      'Bug fixing in unfamiliar code',
      'Performance optimisation',
      'Technical debt reduction',
      'Working inside an existing codebase',
      'Reliability improvements',
    ],
    technologies: ['Java', 'Spring Boot', 'TypeScript', 'Node.js', 'PostgreSQL', 'Git'],
  },
];

export interface DefaultTemplate {
  name: string;
  kind: 'INITIAL' | 'FOLLOW_UP' | 'FINAL';
  subject: string;
  body: string;
}

/**
 * Templates follow the structure in brief §18. Every substantive claim is a
 * variable the operator fills in from their own research — there is no
 * pre-written flattery, no invented observation, and no manufactured urgency.
 *
 * The compliance footer (sender identity, postal address, unsubscribe link) is
 * appended by the template engine, not written here, so it cannot be edited
 * away.
 */
export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    name: 'Initial outreach',
    kind: 'INITIAL',
    subject: '{{company_name}} — {{relevant_service}}',
    body: `Hi {{first_name}},

I noticed {{specific_observation}}.

I'm reaching out because {{why_relevant}}.

I do {{relevant_service}} for teams like yours — {{specific_offer}}.

Given {{engineering_signal}}, {{pain_point}} seemed like it might be worth a conversation.

Would a short call sometime in the next couple of weeks be useful? If it's not relevant right now, just say so and I won't follow up.

Best,
{{sender_name}}
{{sender_title}}`,
  },
  {
    name: 'Follow-up 1 — one new angle',
    kind: 'FOLLOW_UP',
    subject: 'Re: {{company_name}} — {{relevant_service}}',
    body: `Hi {{first_name}},

Following up on my note about {{pain_point}}.

One thing I didn't mention: {{specific_offer}}.

If this isn't a priority right now, that's completely fine — let me know and I'll stop here.

{{sender_name}}`,
  },
  {
    name: 'Follow-up 2 — different angle',
    kind: 'FOLLOW_UP',
    subject: 'One more thought on {{company_name}}',
    body: `Hi {{first_name}},

Last substantive note from me.

{{specific_observation}} — which is usually where {{relevant_service}} pays for itself quickly.

Happy to share how I'd approach it in fifteen minutes, no obligation. And if the timing is wrong, I understand.

{{sender_name}}`,
  },
  {
    name: 'Final — polite close',
    kind: 'FINAL',
    subject: 'Closing the loop, {{first_name}}',
    body: `Hi {{first_name}},

I haven't heard back, so I'll assume the timing isn't right and leave it there.

If {{pain_point}} becomes a priority later, my details are below and I'd be glad to help.

Thanks for your time,
{{sender_name}}`,
  },
];

/** The Day 0 / +4 / +9 / +16 default from brief §26, stored as data. */
export const DEFAULT_SEQUENCE = [
  { delayDays: 0, templateIndex: 0 },
  { delayDays: 4, templateIndex: 1 },
  { delayDays: 5, templateIndex: 2 },
  { delayDays: 7, templateIndex: 3 },
];

/** Conservative starting windows: mid-morning and mid-afternoon on weekdays. */
export const DEFAULT_SENDING_WINDOWS = [
  { start: '09:00', end: '11:30' },
  { start: '13:00', end: '16:30' },
];

export const DEFAULT_SEND_DAYS = [1, 2, 3, 4, 5];
