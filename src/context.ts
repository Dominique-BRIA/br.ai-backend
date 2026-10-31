import type { Message } from "@br-ia/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { KitchenHooks } from "./agents/cuisinier.ts";
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
  /** Appelé après chaque message d'un membre : l'agent serveur le traite en arrière-plan. */
  onMemberMessage: (message: Message, teamId: string) => void;
  /** La cuisine : machines disponibles et résultats des outils. */
  kitchen: KitchenHooks;
  log: FastifyBaseLogger;
}
