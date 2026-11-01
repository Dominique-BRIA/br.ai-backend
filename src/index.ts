import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseChain } from "./ai/client.ts";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { betaInvites } from "./db/schema.ts";
import { ResendMailer } from "./mail/mailer.ts";
import { B2Storage, DiskStorage } from "./storage/storage.ts";

/** Code d'invitation créé automatiquement en développement, pour tester sans tableau de bord. */
const DEV_INVITE_CODE = "BETA-DEV";

const config = loadConfig();
const database = await openDatabase(config.PGLITE_DIR);

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
};
const serveurChain = parseChain(config.AI_SERVEUR_CHAIN, aiKeys);
const cuisinierChain = parseChain(config.AI_CUISINIER_CHAIN, aiKeys);

const { app } = await buildApp({
  serveurChain,
  cuisinierChain,
  storage: b2 ? new B2Storage(b2) : new DiskStorage(config.FILES_DIR),
  database,
  adminToken: config.ADMIN_TOKEN,
  mailer: config.RESEND_API_KEY ? new ResendMailer(config.RESEND_API_KEY, config.MAIL_FROM) : undefined,
  logger:
    config.NODE_ENV === "development"
      ? { level: "info", transport: { target: "pino-pretty" } }
      : { level: "info" },
});

if (config.NODE_ENV === "development") {
  const [existing] = await database.db
    .select()
    .from(betaInvites)
    .where(eq(betaInvites.code, DEV_INVITE_CODE));
  if (!existing) {
    await database.db
      .insert(betaInvites)
      .values({ code: DEV_INVITE_CODE, maxUses: 100, note: "développement" });
  }
  app.log.info(`Code d'invitation de développement : ${DEV_INVITE_CODE}`);
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

await app.listen({ host: config.HOST, port: config.PORT });
