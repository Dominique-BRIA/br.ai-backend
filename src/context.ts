import type { FastifyBaseLogger } from "fastify";
import type { Database } from "./db/client.ts";
import type { Mailer } from "./mail/mailer.ts";
import type { RealtimeHub } from "./realtime/hub.ts";
import type { Storage } from "./storage/storage.ts";

/** Ce dont les routes et les services ont besoin. */
export interface AppContext {
  db: Database["db"];
  hub: RealtimeHub;
  mailer: Mailer;
  storage: Storage;
  log: FastifyBaseLogger;
}
