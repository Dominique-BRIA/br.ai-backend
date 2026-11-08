import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseChain } from "./ai/client.ts";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase, openPostgres } from "./db/client.ts";
import { promoCodes } from "./db/schema.ts";
import { ResendMailer } from "./mail/mailer.ts";
import { Vault } from "./secrets/vault.ts";
import { githubAppFrom } from "./services/githubApp.ts";
import { B2Storage, DiskStorage } from "./storage/storage.ts";

/** Code d'invitation créé automatiquement en développement, pour tester sans tableau de bord. */
const DEV_CREDITS_CODE = "BRIA-DEV";

const config = loadConfig();
// En production, la base est PostgreSQL (Neon) ; en développement, PGlite, même si DATABASE_URL est
// renseignée, pour que les essais locaux ne touchent jamais les données des testeurs.
if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
  throw new Error("DATABASE_URL est obligatoire en production.");
}
const database =
  config.NODE_ENV === "production" && config.DATABASE_URL
    ? await openPostgres(config.DATABASE_URL, config.DATABASE_DIRECT)
    : await openDatabase(config.PGLITE_DIR);

const b2 =
  config.B2_KEY_ID && config.B2_APPLICATION_KEY && config.B2_BUCKET && config.B2_ENDPOINT
    ? {
        keyId: config.B2_KEY_ID,
        applicationKey: config.B2_APPLICATION_KEY,
        bucket: config.B2_BUCKET,
        endpoint: config.B2_ENDPOINT,
      }
    : null;

const aiKeys = {
  gemini: config.GEMINI_API_KEY,
  groq: config.GROQ_API_KEY,
  mistral: config.MISTRAL_API_KEY,
  openrouter: config.OPENROUTER_API_KEY,
  zai: config.ZAI_API_KEY,
};
const serveurChain = parseChain(config.AI_SERVEUR_CHAIN, aiKeys);
const cuisinierChain = parseChain(config.AI_CUISINIER_CHAIN, aiKeys);

const { app, kitchen } = await buildApp({
  serveurChain,
  cuisinierChain,
  storage: b2 ? new B2Storage(b2) : new DiskStorage(config.FILES_DIR),
  database,
  adminToken: config.ADMIN_TOKEN,
  vault: config.SECRETS_KEY ? new Vault(config.SECRETS_KEY) : null,
  githubApp: githubAppFrom(config),
  siteRelayKey: config.SITE_RELAY_KEY,
  mailer: config.RESEND_API_KEY ? new ResendMailer(config.RESEND_API_KEY, config.MAIL_FROM) : undefined,
  logger:
    config.NODE_ENV === "development"
      ? { level: "info", transport: { target: "pino-pretty" } }
      : { level: "info" },
});

if (config.NODE_ENV === "development") {
  const [existing] = await database.db.select().from(promoCodes).where(eq(promoCodes.code, DEV_CREDITS_CODE));
  if (!existing) {
    await database.db.insert(promoCodes).values({
      code: DEV_CREDITS_CODE,
      kind: "credits",
      credits: 100_000,
      durationMonths: 1,
      onePerAccount: false,
      note: "développement",
    });
  }
  app.log.info(`Code de crédits de développement : ${DEV_CREDITS_CODE}`);
}
app.log.info(
  `Agent serveur : ${serveurChain.map((choice) => `${choice.provider.name}/${choice.model}`).join(", ") || "désactivé"}`,
);
app.log.info(
  `Cuisinier : ${cuisinierChain.map((choice) => `${choice.provider.name}/${choice.model}`).join(", ") || "désactivé"}`,
);
app.log.info(
  b2
    ? `Pièces jointes sur Backblaze B2 (${b2.bucket}).`
    : `Pièces jointes sur le disque (${config.FILES_DIR}).`,
);

// Un arrêt inattendu est noté directement dans un fichier : les journaux passent par un
// fil séparé (pino-pretty) qui peut disparaître avec le processus sans avoir tout écrit.
const crashLog = join(config.PGLITE_DIR, "..", "arrets.log");
const noteExit = (reason: string) =>
  appendFileSync(crashLog, `${new Date().toISOString()} ${reason}\n`, { encoding: "utf8" });
process.on("uncaughtException", (error) => {
  noteExit(`exception non rattrapée : ${error.stack ?? error.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  noteExit(`promesse rejetée non traitée : ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on("exit", (code) => noteExit(`arrêt du processus, code ${code}`));

const shutdown = async () => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await kitchen
  ?.recoverInterrupted()
  .catch((error: unknown) => app.log.error({ err: error }, "reprise des commandes impossible"));
await app.listen({ host: config.HOST, port: config.PORT });
