/**
 * Database schema. See docs/data-model.md for the rationale behind the shape.
 *
 * Conventions:
 *  - every business table carries `user_id` so authorization is row-scoped
 *  - all timestamps are `timestamptz`; the application works in UTC
 *  - `normalized_*` columns hold the deterministic form used for deduplication
 *    and suppression matching, never the display form
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const userRoleEnum = pgEnum('user_role', ['OWNER', 'OPERATOR']);

export const prospectStatusEnum = pgEnum('prospect_status', [
  'DISCOVERED',
  'RESEARCHING',
  'QUALIFIED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'CONTACTED',
  'FOLLOW_UP_1',
  'FOLLOW_UP_2',
  'REPLIED',
  'MEETING_BOOKED',
  'PROPOSAL_SENT',
  'NEGOTIATION',
  'WON',
  'LOST',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
  'INVALID',
  'BOUNCED',
]);

export const qualificationBandEnum = pgEnum('qualification_band', [
  'HIGH_PRIORITY',
  'STRONG',
  'POTENTIAL',
  'WEAK',
  'POOR',
]);

export const roleCategoryEnum = pgEnum('role_category', [
  'FOUNDER',
  'CO_FOUNDER',
  'CTO',
  'VP_ENGINEERING',
  'HEAD_OF_ENGINEERING',
  'ENGINEERING_MANAGER',
  'TECHNICAL_DECISION_MAKER',
  'OTHER',
  'UNKNOWN',
]);

export const templateKindEnum = pgEnum('template_kind', ['INITIAL', 'FOLLOW_UP', 'FINAL']);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'DRAFT',
  'READY',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'ARCHIVED',
]);

export const campaignMemberStatusEnum = pgEnum('campaign_member_status', [
  'ACTIVE',
  'STOPPED',
  'COMPLETED',
]);

export const stopReasonEnum = pgEnum('stop_reason', [
  'REPLY_RECEIVED',
  'MEETING_BOOKED',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
  'BOUNCED',
  'SUPPRESSED',
  'CAMPAIGN_PAUSED',
  'MANUALLY_REMOVED',
  'SEQUENCE_COMPLETED',
]);

export const messageDirectionEnum = pgEnum('message_direction', ['OUTBOUND', 'INBOUND']);

export const messageStatusEnum = pgEnum('message_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'BOUNCED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
]);

export const attemptStatusEnum = pgEnum('attempt_status', [
  'STARTED',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
]);

export const replyClassificationEnum = pgEnum('reply_classification', [
  'UNCLASSIFIED',
  'POSITIVE',
  'INTERESTED',
  'QUESTION',
  'NOT_INTERESTED',
  'REFERRAL',
  'OTHER',
]);

export const suppressionReasonEnum = pgEnum('suppression_reason', [
  'UNSUBSCRIBED',
  'DO_NOT_CONTACT',
  'BOUNCED',
  'INVALID',
  'MANUAL_BLOCK',
]);

export const suppressionScopeEnum = pgEnum('suppression_scope', ['EMAIL', 'DOMAIN']);

export const jobStatusEnum = pgEnum('job_status', [
  'PENDING',
  'CLAIMED',
  'DONE',
  'FAILED',
  'CANCELLED',
]);

export const actorTypeEnum = pgEnum('actor_type', ['USER', 'SYSTEM', 'WEBHOOK']);

export const contractTypeEnum = pgEnum('contract_type', ['HOURLY', 'FIXED', 'RETAINER']);

export const dealStatusEnum = pgEnum('deal_status', ['OPEN', 'WON', 'LOST']);

export const meetingStatusEnum = pgEnum('meeting_status', [
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
]);

/* -------------------------------------------------------------------------- */
/* Shared column helpers                                                      */
/* -------------------------------------------------------------------------- */

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    normalizedEmail: text('normalized_email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull().default('OWNER'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_normalized_email_key').on(t.normalizedEmail)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the cookie value. The raw token is never persisted.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const userProfiles = pgTable(
  'user_profiles',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    title: text('title').notNull().default(''),
    bio: text('bio').notNull().default(''),
    location: text('location').notNull().default(''),
    timezone: text('timezone').notNull().default('America/New_York'),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    portfolioUrl: text('portfolio_url'),
    githubUrl: text('github_url'),
    linkedinUrl: text('linkedin_url'),
    skills: jsonb('skills').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    industries: jsonb('industries').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    hourlyRate: numeric('hourly_rate', { precision: 12, scale: 2 }),
    minimumProjectValue: numeric('minimum_project_value', { precision: 12, scale: 2 }),
    availability: text('availability').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_profiles_user_id_key').on(t.userId)],
);

/**
 * Runtime configuration. Environment variables supply defaults; a populated
 * column here wins, so limits can be tightened without a redeploy.
 */
export const settings = pgTable(
  'settings',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Global kill switch. Checked by UI, scheduler, and inside the send transaction. */
    globalSendPaused: boolean('global_send_paused').notNull().default(false),
    globalPauseReason: text('global_pause_reason'),
    globalPausedAt: timestamp('global_paused_at', { withTimezone: true }),

    dailySendLimit: integer('daily_send_limit'),
    hourlySendLimit: integer('hourly_send_limit'),
    perDomainDailyLimit: integer('per_domain_daily_limit'),
    minDelaySeconds: integer('min_delay_seconds'),
    maxDelaySeconds: integer('max_delay_seconds'),

    defaultTimezone: text('default_timezone'),
    followupEnabled: boolean('followup_enabled'),

    qualificationWeights: jsonb('qualification_weights').$type<Record<string, number>>(),

    /** CAN-SPAM: required physical postal address. Sending is blocked without it. */
    postalAddress: text('postal_address').notNull().default(''),
    unsubscribeFooter: text('unsubscribe_footer').notNull().default(''),
    advertisingDisclosure: text('advertising_disclosure').notNull().default(''),

    retentionDaysActivities: integer('retention_days_activities'),
    retentionDaysMessages: integer('retention_days_messages'),
    retentionDaysWebhookEvents: integer('retention_days_webhook_events'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('settings_user_id_key').on(t.userId)],
);

/* -------------------------------------------------------------------------- */
/* Prospecting                                                                */
/* -------------------------------------------------------------------------- */

export const companies = pgTable(
  'companies',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    domain: text('domain'),
    normalizedDomain: text('normalized_domain'),
    website: text('website'),
    linkedinUrl: text('linkedin_url'),
    country: text('country').notNull().default('US'),
    state: text('state'),
    city: text('city'),
    timezone: text('timezone'),
    industry: text('industry'),
    companySize: text('company_size'),
    fundingStage: text('funding_stage'),
    description: text('description'),
    technologyStack: jsonb('technology_stack').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    engineeringSignals: jsonb('engineering_signals').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    hiringSignals: jsonb('hiring_signals').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    painPoints: jsonb('pain_points').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    source: text('source').notNull().default('MANUAL'),
    sourceUrl: text('source_url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Deduplication keys. Partial so companies without a known domain do not collide on NULL.
    uniqueIndex('companies_user_domain_key')
      .on(t.userId, t.normalizedDomain)
      .where(sql`${t.normalizedDomain} is not null`),
    uniqueIndex('companies_user_name_key').on(t.userId, t.normalizedName),
    index('companies_user_industry_idx').on(t.userId, t.industry),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    fullName: text('full_name').notNull(),
    role: text('role'),
    roleCategory: roleCategoryEnum('role_category').notNull().default('UNKNOWN'),
    email: text('email').notNull(),
    normalizedEmail: text('normalized_email').notNull(),
    linkedinUrl: text('linkedin_url'),
    timezone: text('timezone'),
    /** Why this specific person is being contacted (brief §4). */
    contactReason: text('contact_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('contacts_user_email_key').on(t.userId, t.normalizedEmail),
    index('contacts_company_id_idx').on(t.companyId),
  ],
);

export const prospects = pgTable(
  'prospects',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: prospectStatusEnum('status').notNull().default('DISCOVERED'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    qualificationScore: integer('qualification_score'),
    qualificationBand: qualificationBandEnum('qualification_band'),
    serviceId: uuid('service_id'),
    notes: text('notes'),
    doNotContactReason: text('do_not_contact_reason'),
    lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
    nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One live prospect per contact: prevents two pipeline rows racing to email the same person.
    uniqueIndex('prospects_contact_id_key').on(t.contactId),
    index('prospects_user_status_idx').on(t.userId, t.status),
    index('prospects_user_score_idx').on(t.userId, t.qualificationScore.desc()),
    index('prospects_user_created_idx').on(t.userId, t.createdAt.desc(), t.id),
    index('prospects_user_last_contacted_idx').on(t.userId, t.lastContactedAt),
    index('prospects_followup_idx')
      .on(t.userId, t.nextFollowUpAt)
      .where(sql`${t.nextFollowUpAt} is not null`),
    index('prospects_company_id_idx').on(t.companyId),
  ],
);

export const qualificationScores = pgTable(
  'qualification_scores',
  {
    id: id(),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    band: qualificationBandEnum('band').notNull(),
    /** [{code, label, points, source}] — every point traceable to a reason. */
    reasons: jsonb('reasons').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** The exact tri-state inputs used, so a re-score is explicable after weights change. */
    signals: jsonb('signals').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    weightsVersion: text('weights_version').notNull().default('v1'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('qualification_scores_prospect_idx').on(t.prospectId, t.computedAt.desc())],
);

export const research = pgTable(
  'research',
  {
    id: id(),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    companyDescription: text('company_description'),
    product: text('product'),
    targetCustomers: text('target_customers'),
    technologyStack: text('technology_stack'),
    engineeringTeamSize: text('engineering_team_size'),
    hiringActivity: text('hiring_activity'),
    recentProductActivity: text('recent_product_activity'),
    potentialPainPoint: text('potential_pain_point'),
    whyRelevant: text('why_relevant'),
    whyContactingThem: text('why_contacting_them'),
    reasonForReachingOutNow: text('reason_for_reaching_out_now'),
    additionalNotes: text('additional_notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('research_prospect_id_key').on(t.prospectId)],
);

export const researchSources = pgTable(
  'research_sources',
  {
    id: id(),
    researchId: uuid('research_id')
      .notNull()
      .references(() => research.id, { onDelete: 'cascade' }),
    /** Which research field this source substantiates. */
    field: text('field').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('research_sources_research_idx').on(t.researchId, t.field)],
);

/* -------------------------------------------------------------------------- */
/* Offering                                                                   */
/* -------------------------------------------------------------------------- */

export const services = pgTable(
  'services',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    bullets: jsonb('bullets').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    technologies: jsonb('technologies').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('services_user_key_key').on(t.userId, t.key)],
);

export const portfolioItems = pgTable(
  'portfolio_items',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    technologies: jsonb('technologies').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    url: text('url'),
    githubUrl: text('github_url'),
    imageUrl: text('image_url'),
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Public work only. The UI warns against confidential client material. */
    isPublic: boolean('is_public').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('portfolio_items_user_idx').on(t.userId)],
);

/* -------------------------------------------------------------------------- */
/* Outreach                                                                   */
/* -------------------------------------------------------------------------- */

export const templates = pgTable(
  'templates',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: templateKindEnum('kind').notNull().default('INITIAL'),
    subjectTemplate: text('subject_template').notNull(),
    bodyTemplate: text('body_template').notNull(),
    /** Derived on save from the template text; used to gate approval. */
    requiredVariables: jsonb('required_variables').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('templates_user_kind_idx').on(t.userId, t.kind)],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    status: campaignStatusEnum('status').notNull().default('DRAFT'),
    targetCriteria: jsonb('target_criteria').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    dailyLimit: integer('daily_limit'),
    hourlyLimit: integer('hourly_limit'),
    timezone: text('timezone').notNull().default('America/New_York'),
    /** [{start:"09:00", end:"11:30"}] in campaign-local wall clock. */
    sendingWindows: jsonb('sending_windows')
      .$type<{ start: string; end: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** ISO weekday numbers, 1=Monday. */
    sendDays: jsonb('send_days').$type<number[]>().notNull().default(sql`'[1,2,3,4,5]'::jsonb`),
    startedAt: timestamp('started_at', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('campaigns_user_status_idx').on(t.userId, t.status)],
);

export const campaignSteps = pgTable(
  'campaign_steps',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    delayDays: integer('delay_days').notNull().default(0),
    delayHours: integer('delay_hours').notNull().default(0),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('campaign_steps_campaign_position_key').on(t.campaignId, t.position)],
);

export const campaignMembers = pgTable(
  'campaign_members',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    status: campaignMemberStatusEnum('status').notNull().default('ACTIVE'),
    currentPosition: integer('current_position').notNull().default(0),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    stopReason: stopReasonEnum('stop_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('campaign_members_campaign_prospect_key').on(t.campaignId, t.prospectId),
    // A prospect may be ACTIVE in at most one campaign at a time (brief §24).
    uniqueIndex('campaign_members_one_active_key')
      .on(t.prospectId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index('campaign_members_campaign_status_idx').on(t.campaignId, t.status),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    campaignMemberId: uuid('campaign_member_id').references(() => campaignMembers.id, {
      onDelete: 'set null',
    }),
    campaignStepId: uuid('campaign_step_id').references(() => campaignSteps.id, {
      onDelete: 'set null',
    }),
    templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
    direction: messageDirectionEnum('direction').notNull().default('OUTBOUND'),
    toEmail: text('to_email').notNull(),
    fromEmail: text('from_email'),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    /** Exactly what was interpolated, retained for audit. */
    variables: jsonb('variables').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    status: messageStatusEnum('status').notNull().default('DRAFT'),
    /** SHA-256 over recipient + subject + body. Approval is bound to this value. */
    contentHash: text('content_hash').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    providerMessageId: text('provider_message_id'),
    blockedReason: text('blocked_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One message per sequence step per enrolment. Permanent duplicate-send guard.
    uniqueIndex('messages_member_step_key')
      .on(t.campaignMemberId, t.campaignStepId)
      .where(sql`${t.campaignMemberId} is not null and ${t.campaignStepId} is not null`),
    index('messages_user_status_scheduled_idx').on(t.userId, t.status, t.scheduledAt),
    index('messages_prospect_created_idx').on(t.prospectId, t.createdAt),
    index('messages_contact_idx').on(t.contactId),
    index('messages_provider_message_id_idx').on(t.providerMessageId),
  ],
);

export const messageApprovals = pgTable(
  'message_approvals',
  {
    id: id(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    approvalVersion: integer('approval_version').notNull().default(1),
    /** Must match the message's current content_hash at send time, or the send is blocked. */
    contentHash: text('content_hash').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('message_approvals_message_version_key').on(t.messageId, t.approvalVersion),
    index('message_approvals_message_idx').on(t.messageId),
  ],
);

export const messageAttempts = pgTable(
  'message_attempts',
  {
    id: id(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    /**
     * Deterministic from message id + attempt number, inserted BEFORE the
     * provider call. A crashed-and-retried worker hits this unique constraint
     * instead of sending twice.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    status: attemptStatusEnum('status').notNull().default('STARTED'),
    provider: text('provider').notNull(),
    providerMessageId: text('provider_message_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('message_attempts_idempotency_key').on(t.idempotencyKey),
    index('message_attempts_message_idx').on(t.messageId, t.attemptNumber),
  ],
);

export const replies = pgTable(
  'replies',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    providerMessageId: text('provider_message_id'),
    fromEmail: text('from_email').notNull(),
    subject: text('subject'),
    bodyText: text('body_text'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Human-assigned only. Nothing infers this (brief §34). */
    classification: replyClassificationEnum('classification').notNull().default('UNCLASSIFIED'),
    classifiedBy: uuid('classified_by').references(() => users.id, { onDelete: 'set null' }),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('replies_prospect_idx').on(t.prospectId, t.receivedAt.desc()),
    index('replies_user_unread_idx').on(t.userId, t.readAt),
  ],
);

export const suppressionList = pgTable(
  'suppression_list',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: suppressionScopeEnum('scope').notNull().default('EMAIL'),
    normalizedEmail: text('normalized_email'),
    normalizedDomain: text('normalized_domain'),
    reason: suppressionReasonEnum('reason').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: uuid('removed_by').references(() => users.id, { onDelete: 'set null' }),
    removedReason: text('removed_reason'),
  },
  (t) => [
    uniqueIndex('suppression_email_live_key')
      .on(t.userId, t.normalizedEmail)
      .where(sql`${t.scope} = 'EMAIL' and ${t.removedAt} is null and ${t.normalizedEmail} is not null`),
    uniqueIndex('suppression_domain_live_key')
      .on(t.userId, t.normalizedDomain)
      .where(sql`${t.scope} = 'DOMAIN' and ${t.removedAt} is null and ${t.normalizedDomain} is not null`),
    index('suppression_user_created_idx').on(t.userId, t.createdAt.desc()),
  ],
);

export const unsubscribeTokens = pgTable(
  'unsubscribe_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token in the link; the raw value is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('unsubscribe_tokens_hash_key').on(t.tokenHash),
    index('unsubscribe_tokens_contact_idx').on(t.contactId),
  ],
);

/* -------------------------------------------------------------------------- */
/* CRM                                                                        */
/* -------------------------------------------------------------------------- */

export const activities = pgTable(
  'activities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('activities_prospect_occurred_idx').on(t.prospectId, t.occurredAt.desc())],
);

export const meetings = pgTable(
  'meetings',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull().default('America/New_York'),
    meetingUrl: text('meeting_url'),
    notes: text('notes'),
    outcome: text('outcome'),
    nextAction: text('next_action'),
    status: meetingStatusEnum('status').notNull().default('SCHEDULED'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('meetings_user_scheduled_idx').on(t.userId, t.scheduledFor)],
);

export const deals = pgTable(
  'deals',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    estimatedValue: numeric('estimated_value', { precision: 12, scale: 2 }),
    currency: text('currency').notNull().default('USD'),
    proposalDate: timestamp('proposal_date', { withTimezone: true }),
    expectedCloseDate: timestamp('expected_close_date', { withTimezone: true }),
    contractType: contractTypeEnum('contract_type'),
    hourlyRate: numeric('hourly_rate', { precision: 12, scale: 2 }),
    estimatedHours: integer('estimated_hours'),
    retainerValue: numeric('retainer_value', { precision: 12, scale: 2 }),
    status: dealStatusEnum('status').notNull().default('OPEN'),
    notes: text('notes'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('deals_prospect_id_key').on(t.prospectId),
    index('deals_user_status_idx').on(t.userId, t.status),
  ],
);

/* -------------------------------------------------------------------------- */
/* Infrastructure                                                             */
/* -------------------------------------------------------------------------- */

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: jobStatusEnum('status').notNull().default('PENDING'),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    lastError: text('last_error'),
    /** Enqueue idempotency: the same logical job cannot be queued twice. */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_status_run_after_idx').on(t.status, t.runAfter),
    uniqueIndex('jobs_dedupe_key_key').on(t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
    index('jobs_claimed_at_idx').on(t.claimedAt).where(sql`${t.status} = 'CLAIMED'`),
  ],
);

/** Append-only. The application contains no UPDATE or DELETE against this table. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    actorType: actorTypeEnum('actor_type').notNull().default('USER'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    requestId: text('request_id'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc()),
    index('audit_logs_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('audit_logs_action_idx').on(t.action, t.createdAt.desc()),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    /** Unique: makes webhook delivery idempotent and defeats replay. */
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    signatureVerified: boolean('signature_verified').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('webhook_events_provider_event_key').on(t.provider, t.providerEventId),
    index('webhook_events_received_idx').on(t.receivedAt.desc()),
  ],
);

/**
 * Narrow append-only ledger used purely for rate-limit counting, so limit
 * checks never scan the wide `messages` table.
 */
export const sendLedger = pgTable(
  'send_ledger',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    recipientDomain: text('recipient_domain').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('send_ledger_user_sent_idx').on(t.userId, t.sentAt),
    index('send_ledger_user_domain_sent_idx').on(t.userId, t.recipientDomain, t.sentAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type UserProfile = typeof userProfiles.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Prospect = typeof prospects.$inferSelect;
export type NewProspect = typeof prospects.$inferInsert;
export type Research = typeof research.$inferSelect;
export type ResearchSource = typeof researchSources.$inferSelect;
export type Service = typeof services.$inferSelect;
export type PortfolioItem = typeof portfolioItems.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignStep = typeof campaignSteps.$inferSelect;
export type CampaignMember = typeof campaignMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageApproval = typeof messageApprovals.$inferSelect;
export type MessageAttempt = typeof messageAttempts.$inferSelect;
export type Reply = typeof replies.$inferSelect;
export type Suppression = typeof suppressionList.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
