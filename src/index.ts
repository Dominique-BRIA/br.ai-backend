import { eq } from "drizzle-orm";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { betaInvites } from "./db/schema.ts";
import { ResendMailer } from "./mail/mailer.ts";

/** Code d'invitation créé automatiquement en développement, pour tester sans tableau de bord. */
const DEV_INVITE_CODE = "BETA-DEV";

const config = loadConfig();
const database = await openDatabase(config.PGLITE_DIR);

const app = await buildApp({
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

const shutdown = async () => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
