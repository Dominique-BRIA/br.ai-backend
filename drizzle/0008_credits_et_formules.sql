CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"month" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"max_members" integer NOT NULL,
	"max_projects" integer NOT NULL,
	"monthly_credits" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO "plans" ("id", "name", "max_members", "max_projects", "monthly_credits", "sort_order") VALUES
	('essai', 'Essai', 3, 2, 2000, 1),
	('solo', 'Solo', 1, 5, 5000, 2),
	('etudiant', 'Étudiant', 6, 5, 10000, 3),
	('equipe', 'Équipe', 8, 10, 20000, 4),
	('entreprise', 'Entreprise', 50, 100, 100000, 5);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "platform_settings" ("key", "value") VALUES ('creditRates', '{"default":{"input":1,"output":3},"models":{}}');
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD COLUMN "credits" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "plan_id" text DEFAULT 'essai' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "plan_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "quota_warned_month" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "quota_exceeded_month" text;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_grants_team_id_month_index" ON "credit_grants" USING btree ("team_id","month");--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;