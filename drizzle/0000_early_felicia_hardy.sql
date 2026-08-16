CREATE TYPE "public"."actor_type" AS ENUM('USER', 'SYSTEM', 'WEBHOOK');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('STARTED', 'SUCCEEDED', 'FAILED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."campaign_member_status" AS ENUM('ACTIVE', 'STOPPED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."contract_type" AS ENUM('HOURLY', 'FIXED', 'RETAINER');--> statement-breakpoint
CREATE TYPE "public"."deal_status" AS ENUM('OPEN', 'WON', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'CLAIMED', 'DONE', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('OUTBOUND', 'INBOUND');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED', 'BLOCKED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."prospect_status" AS ENUM('DISCOVERED', 'RESEARCHING', 'QUALIFIED', 'READY_FOR_REVIEW', 'APPROVED', 'CONTACTED', 'FOLLOW_UP_1', 'FOLLOW_UP_2', 'REPLIED', 'MEETING_BOOKED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST', 'NOT_INTERESTED', 'DO_NOT_CONTACT', 'INVALID', 'BOUNCED');--> statement-breakpoint
CREATE TYPE "public"."qualification_band" AS ENUM('HIGH_PRIORITY', 'STRONG', 'POTENTIAL', 'WEAK', 'POOR');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('UNCLASSIFIED', 'POSITIVE', 'INTERESTED', 'QUESTION', 'NOT_INTERESTED', 'REFERRAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."role_category" AS ENUM('FOUNDER', 'CO_FOUNDER', 'CTO', 'VP_ENGINEERING', 'HEAD_OF_ENGINEERING', 'ENGINEERING_MANAGER', 'TECHNICAL_DECISION_MAKER', 'OTHER', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."stop_reason" AS ENUM('REPLY_RECEIVED', 'MEETING_BOOKED', 'NOT_INTERESTED', 'DO_NOT_CONTACT', 'BOUNCED', 'SUPPRESSED', 'CAMPAIGN_PAUSED', 'MANUALLY_REMOVED', 'SEQUENCE_COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('UNSUBSCRIBED', 'DO_NOT_CONTACT', 'BOUNCED', 'INVALID', 'MANUAL_BLOCK');--> statement-breakpoint
CREATE TYPE "public"."suppression_scope" AS ENUM('EMAIL', 'DOMAIN');--> statement-breakpoint
CREATE TYPE "public"."template_kind" AS ENUM('INITIAL', 'FOLLOW_UP', 'FINAL');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'OPERATOR');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"actor_type" "actor_type" DEFAULT 'USER' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"status" "campaign_member_status" DEFAULT 'ACTIVE' NOT NULL,
	"current_position" integer DEFAULT 0 NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_reason" "stop_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"delay_hours" integer DEFAULT 0 NOT NULL,
	"template_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"service_id" uuid,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"target_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_limit" integer,
	"hourly_limit" integer,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"sending_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"send_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"normalized_domain" text,
	"website" text,
	"linkedin_url" text,
	"country" text DEFAULT 'US' NOT NULL,
	"state" text,
	"city" text,
	"timezone" text,
	"industry" text,
	"company_size" text,
	"funding_stage" text,
	"description" text,
	"technology_stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"engineering_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hiring_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pain_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"full_name" text NOT NULL,
	"role" text,
	"role_category" "role_category" DEFAULT 'UNKNOWN' NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"linkedin_url" text,
	"timezone" text,
	"contact_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"estimated_value" numeric(12, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"proposal_date" timestamp with time zone,
	"expected_close_date" timestamp with time zone,
	"contract_type" "contract_type",
	"hourly_rate" numeric(12, 2),
	"estimated_hours" integer,
	"retainer_value" numeric(12, 2),
	"status" "deal_status" DEFAULT 'OPEN' NOT NULL,
	"notes" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"meeting_url" text,
	"notes" text,
	"outcome" text,
	"next_action" text,
	"status" "meeting_status" DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approval_version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "message_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "attempt_status" DEFAULT 'STARTED' NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"campaign_member_id" uuid,
	"campaign_step_id" uuid,
	"template_id" uuid,
	"direction" "message_direction" DEFAULT 'OUTBOUND' NOT NULL,
	"to_email" text NOT NULL,
	"from_email" text,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "message_status" DEFAULT 'DRAFT' NOT NULL,
	"content_hash" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"service_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"technologies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"github_url" text,
	"image_url" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "prospect_status" DEFAULT 'DISCOVERED' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"qualification_score" integer,
	"qualification_band" "qualification_band",
	"service_id" uuid,
	"notes" text,
	"do_not_contact_reason" text,
	"last_contacted_at" timestamp with time zone,
	"next_follow_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualification_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"band" "qualification_band" NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"weights_version" text DEFAULT 'v1' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"message_id" uuid,
	"provider_message_id" text,
	"from_email" text NOT NULL,
	"subject" text,
	"body_text" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"classification" "reply_classification" DEFAULT 'UNCLASSIFIED' NOT NULL,
	"classified_by" uuid,
	"classified_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"company_description" text,
	"product" text,
	"target_customers" text,
	"technology_stack" text,
	"engineering_team_size" text,
	"hiring_activity" text,
	"recent_product_activity" text,
	"potential_pain_point" text,
	"why_relevant" text,
	"why_contacting_them" text,
	"reason_for_reaching_out_now" text,
	"additional_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_id" uuid NOT NULL,
	"field" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "send_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid,
	"recipient_domain" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"technologies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"global_send_paused" boolean DEFAULT false NOT NULL,
	"global_pause_reason" text,
	"global_paused_at" timestamp with time zone,
	"daily_send_limit" integer,
	"hourly_send_limit" integer,
	"per_domain_daily_limit" integer,
	"min_delay_seconds" integer,
	"max_delay_seconds" integer,
	"default_timezone" text,
	"followup_enabled" boolean,
	"qualification_weights" jsonb,
	"postal_address" text DEFAULT '' NOT NULL,
	"unsubscribe_footer" text DEFAULT '' NOT NULL,
	"advertising_disclosure" text DEFAULT '' NOT NULL,
	"retention_days_activities" integer,
	"retention_days_messages" integer,
	"retention_days_webhook_events" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "suppression_scope" DEFAULT 'EMAIL' NOT NULL,
	"normalized_email" text,
	"normalized_domain" text,
	"reason" "suppression_reason" NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removed_reason" text
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "template_kind" DEFAULT 'INITIAL' NOT NULL,
	"subject_template" text NOT NULL,
	"body_template" text NOT NULL,
	"required_variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unsubscribe_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"portfolio_url" text,
	"github_url" text,
	"linkedin_url" text,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"industries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hourly_rate" numeric(12, 2),
	"minimum_project_value" numeric(12, 2),
	"availability" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'OWNER' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_approvals" ADD CONSTRAINT "message_approvals_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_approvals" ADD CONSTRAINT "message_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_member_id_campaign_members_id_fk" FOREIGN KEY ("campaign_member_id") REFERENCES "public"."campaign_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_step_id_campaign_steps_id_fk" FOREIGN KEY ("campaign_step_id") REFERENCES "public"."campaign_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_scores" ADD CONSTRAINT "qualification_scores_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_classified_by_users_id_fk" FOREIGN KEY ("classified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research" ADD CONSTRAINT "research_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_research_id_research_id_fk" FOREIGN KEY ("research_id") REFERENCES "public"."research"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_ledger" ADD CONSTRAINT "send_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_ledger" ADD CONSTRAINT "send_ledger_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_prospect_occurred_idx" ON "activities" USING btree ("prospect_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_user_created_idx" ON "audit_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_members_campaign_prospect_key" ON "campaign_members" USING btree ("campaign_id","prospect_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_members_one_active_key" ON "campaign_members" USING btree ("prospect_id") WHERE "campaign_members"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "campaign_members_campaign_status_idx" ON "campaign_members" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_steps_campaign_position_key" ON "campaign_steps" USING btree ("campaign_id","position");--> statement-breakpoint
CREATE INDEX "campaigns_user_status_idx" ON "campaigns" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_user_domain_key" ON "companies" USING btree ("user_id","normalized_domain") WHERE "companies"."normalized_domain" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_user_name_key" ON "companies" USING btree ("user_id","normalized_name");--> statement-breakpoint
CREATE INDEX "companies_user_industry_idx" ON "companies" USING btree ("user_id","industry");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_email_key" ON "contacts" USING btree ("user_id","normalized_email");--> statement-breakpoint
CREATE INDEX "contacts_company_id_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_prospect_id_key" ON "deals" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "deals_user_status_idx" ON "deals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "jobs_claimed_at_idx" ON "jobs" USING btree ("claimed_at") WHERE "jobs"."status" = 'CLAIMED';--> statement-breakpoint
CREATE INDEX "meetings_user_scheduled_idx" ON "meetings" USING btree ("user_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "message_approvals_message_version_key" ON "message_approvals" USING btree ("message_id","approval_version");--> statement-breakpoint
CREATE INDEX "message_approvals_message_idx" ON "message_approvals" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attempts_idempotency_key" ON "message_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "message_attempts_message_idx" ON "message_attempts" USING btree ("message_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_member_step_key" ON "messages" USING btree ("campaign_member_id","campaign_step_id") WHERE "messages"."campaign_member_id" is not null and "messages"."campaign_step_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_user_status_scheduled_idx" ON "messages" USING btree ("user_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "messages_prospect_created_idx" ON "messages" USING btree ("prospect_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_contact_idx" ON "messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "messages_provider_message_id_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "portfolio_items_user_idx" ON "portfolio_items" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_contact_id_key" ON "prospects" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "prospects_user_status_idx" ON "prospects" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "prospects_user_score_idx" ON "prospects" USING btree ("user_id","qualification_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prospects_user_created_idx" ON "prospects" USING btree ("user_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "prospects_user_last_contacted_idx" ON "prospects" USING btree ("user_id","last_contacted_at");--> statement-breakpoint
CREATE INDEX "prospects_followup_idx" ON "prospects" USING btree ("user_id","next_follow_up_at") WHERE "prospects"."next_follow_up_at" is not null;--> statement-breakpoint
CREATE INDEX "prospects_company_id_idx" ON "prospects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "qualification_scores_prospect_idx" ON "qualification_scores" USING btree ("prospect_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "replies_prospect_idx" ON "replies" USING btree ("prospect_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "replies_user_unread_idx" ON "replies" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_prospect_id_key" ON "research" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "research_sources_research_idx" ON "research_sources" USING btree ("research_id","field");--> statement-breakpoint
CREATE INDEX "send_ledger_user_sent_idx" ON "send_ledger" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "send_ledger_user_domain_sent_idx" ON "send_ledger" USING btree ("user_id","recipient_domain","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "services_user_key_key" ON "services" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_user_id_key" ON "settings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_email_live_key" ON "suppression_list" USING btree ("user_id","normalized_email") WHERE "suppression_list"."scope" = 'EMAIL' and "suppression_list"."removed_at" is null and "suppression_list"."normalized_email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_domain_live_key" ON "suppression_list" USING btree ("user_id","normalized_domain") WHERE "suppression_list"."scope" = 'DOMAIN' and "suppression_list"."removed_at" is null and "suppression_list"."normalized_domain" is not null;--> statement-breakpoint
CREATE INDEX "suppression_user_created_idx" ON "suppression_list" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "templates_user_kind_idx" ON "templates" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "unsubscribe_tokens_hash_key" ON "unsubscribe_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "unsubscribe_tokens_contact_idx" ON "unsubscribe_tokens" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users" USING btree ("normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_key" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at" DESC NULLS LAST);