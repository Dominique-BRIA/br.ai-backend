import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";

const config = loadConfig();
const database = await openDatabase(config.PGLITE_DIR);

const app = await buildApp({
  database,
  logger:
    config.NODE_ENV === "development"
      ? { level: "info", transport: { target: "pino-pretty" } }
      : { level: "info" },
});

const shutdown = async () => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
