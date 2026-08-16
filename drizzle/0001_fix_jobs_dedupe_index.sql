DROP INDEX "jobs_dedupe_key_key";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs" USING btree ("dedupe_key");