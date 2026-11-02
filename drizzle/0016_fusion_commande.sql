ALTER TABLE "orders" ADD COLUMN "pull_request_number" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pull_request_url" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merged_at" timestamp with time zone;