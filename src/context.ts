import type { Message } from "@br-ia/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { KitchenHooks } from "./agents/cuisinier.ts";
import type { Database } from "./db/client.ts";
import type { Mailer } from "./mail/mailer.ts";
import type { RealtimeHub } from "./realtime/hub.ts";
import type { Storage } from "./storage/storage.ts";

/** Ce qu'il faut pour résumer à un membre ce qui s'est passé pendant son absence. */
export interface CatchUpRequest {
  projectId: string;
  teamId: string;
  /** Le membre qui revient : le résumé lui est adressé. */
  userName: string;
  /** Les messages des autres depuis son départ, du plus ancien au plus récent. */
  messages: Message[];
}

/** Ce dont les routes et les services ont besoin. */
export interface AppContext {
  db: Database["db"];
  hub: RealtimeHub;
  mailer: Mailer;
  storage: Storage;
  /** Appelé après chaque message d'un membre : l'agent serveur le traite en arrière-plan. */
  onMemberMessage: (message: Message, teamId: string) => void;
  /** Résumé « pendant ton absence » écrit par l'agent serveur ; `null` sans IA disponible. */
  summarize: (request: CatchUpRequest) => Promise<string | null>;
  /** La cuisine : machines disponibles et résultats des outils. */
  kitchen: KitchenHooks;
  log: FastifyBaseLogger;
}
