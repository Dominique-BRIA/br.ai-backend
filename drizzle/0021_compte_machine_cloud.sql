-- Compte de service de la machine cloud du cuisinier : aucune équipe, connexion par code refusée.
INSERT INTO "users" ("id", "email", "display_name")
VALUES ('00000000-0000-4000-8000-00000000c10d', 'machine-cloud@service.invalid', 'Machine cloud <br/>')
ON CONFLICT ("id") DO NOTHING;
