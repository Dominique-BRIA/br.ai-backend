CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"target_id" text,
	"detail" text,
	"status_code" integer NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_id_admin_accounts_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_created_at_index" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_action_index" ON "admin_audit" USING btree ("action");--> statement-breakpoint
-- Les comptes qui avaient tout le tableau de bord gagnent les deux nouvelles sections.
UPDATE "admin_accounts" SET "permissions" = "permissions" || '["statistiques","journal"]'::jsonb WHERE "permissions" @> '["utilisateurs","equipes","couts","codes","demandes","retours","maintenance","comptes","reglages"]'::jsonb;
