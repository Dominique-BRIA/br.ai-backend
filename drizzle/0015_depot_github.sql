ALTER TABLE "orders" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_full_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_default_branch" text;