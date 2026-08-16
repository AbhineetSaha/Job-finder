CREATE TYPE "public"."candidate_status" AS ENUM('NEW', 'PROMOTED', 'REJECTED', 'DUPLICATE');--> statement-breakpoint
CREATE TYPE "public"."contactability" AS ENUM('OPT_OUT_REGIME', 'CONSENT_REQUIRED', 'EXCLUDED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."discovery_run_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');--> statement-breakpoint
CREATE TABLE "discovered_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"company_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"normalized_domain" text,
	"website" text,
	"description" text,
	"country" text,
	"location_text" text,
	"contactability" "contactability" DEFAULT 'UNKNOWN' NOT NULL,
	"technology_stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"funding_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hiring_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_email" text,
	"contact_name" text,
	"contact_role" text,
	"match_score" integer DEFAULT 0 NOT NULL,
	"match_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "candidate_status" DEFAULT 'NEW' NOT NULL,
	"review_note" text,
	"promoted_prospect_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid,
	"kind" text NOT NULL,
	"status" "discovery_run_status" DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_fetched" integer DEFAULT 0 NOT NULL,
	"candidates_created" integer DEFAULT 0 NOT NULL,
	"duplicates_skipped" integer DEFAULT 0 NOT NULL,
	"excluded_by_geography" integer DEFAULT 0 NOT NULL,
	"below_match_threshold" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovered_candidates" ADD CONSTRAINT "discovered_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_candidates" ADD CONSTRAINT "discovered_candidates_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_candidates" ADD CONSTRAINT "discovered_candidates_promoted_prospect_id_prospects_id_fk" FOREIGN KEY ("promoted_prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_source_id_discovery_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."discovery_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_candidates_dedupe_key" ON "discovered_candidates" USING btree ("user_id","source","normalized_name");--> statement-breakpoint
CREATE INDEX "discovered_candidates_user_status_idx" ON "discovered_candidates" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "discovered_candidates_user_score_idx" ON "discovered_candidates" USING btree ("user_id","match_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "discovered_candidates_domain_idx" ON "discovered_candidates" USING btree ("user_id","normalized_domain");--> statement-breakpoint
CREATE INDEX "discovered_candidates_run_idx" ON "discovered_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_runs_user_started_idx" ON "discovery_runs" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_sources_user_name_key" ON "discovery_sources" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "discovery_sources_user_kind_idx" ON "discovery_sources" USING btree ("user_id","kind");