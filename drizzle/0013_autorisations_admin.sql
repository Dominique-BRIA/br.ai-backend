ALTER TABLE "admin_accounts" ADD COLUMN "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Les comptes existants gardent l'accès à tout le tableau de bord.
UPDATE "admin_accounts" SET "permissions" = '["utilisateurs","equipes","couts","codes","demandes","retours","maintenance","comptes","reglages"]'::jsonb;
