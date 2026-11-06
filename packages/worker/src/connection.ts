import { hostname } from "node:os";
import { PROTOCOL_VERSION, parseServerMessage, WS_PATH } from "@br-ia/protocol";
import WebSocket from "ws";
import type { CloudTools } from "./tools.ts";

/** Une réponse d'outil est limitée à 200 000 caractères par le protocole. */
const MAX_RESULT = 190_000;
const PING_MS = 30_000;
const MAX_RETRY_MS = 60_000;

/** Envoie le .zip d'une commande au serveur, avec le jeton de la machine. */
export function deliverTo(serverUrl: string, token: string) {
  return async (orderId: string, name: string, bytes: Uint8Array): Promise<string> => {
    const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/cloud/orders/${orderId}/deliverable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/zip",
        "x-bria-file-name": name,
      },
      body: bytes,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Envoi du fichier .zip refusé (${response.status}).`);
    return ((await response.json()) as { attachmentId: string }).attachmentId;
  };
}

export interface WorkerLog {
  info(text: string): void;
  error(text: string): void;
}

/**
 * Relie la machine cloud au serveur <br/> et exécute les outils demandés, jusqu'à l'appel de
 * `stop`. Se reconnecte seule après une coupure ; un jeton refusé arrête le travailleur.
 */
export function connectWorker(options: {
  serverUrl: string;
  token: string;
  tools: CloudTools;
  log: WorkerLog;
  onRefused?: (reason: string) => void;
}): { stop: () => void } {
  const { token, tools, log } = options;
  const url = `${options.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${WS_PATH}`;
  let socket: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const current = new WebSocket(url);
    socket = current;
    current.on("open", () => {
      current.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token,
          machine: {
            id: `cloud-${hostname()}`.slice(0, 100),
            os: "linux",
            editor: "Machine cloud",
            editorVersion: "1",
            extensionVersion: "travailleur",
          },
        }),
      );
    });
    current.on("message", (data) => {
      const message = parseServerMessage(data.toString());
      if (!message) return;
      if (message.type === "welcome") {
        delay = 1000;
        log.info("Connectée au serveur <br/>.");
        ping = setInterval(() => {
          if (current.readyState === current.OPEN) {
            current.send(JSON.stringify({ type: "ping", sentAt: Date.now() }));
          }
        }, PING_MS);
      } else if (message.type === "error") {
        if (message.code === "unauthenticated" || message.code === "protocol_mismatch") {
          stopped = true;
          log.error(`Connexion refusée : ${message.message}`);
          options.onRefused?.(message.code);
        }
      } else if (message.type === "tool.call") {
        // Le contenu des outils n'est pas journalisé : il peut contenir le jeton de la commande.
        log.info(`Outil ${message.tool}, commande ${message.orderId}.`);
        void tools.handle(message.orderId, message.tool, message.input).then((outcome) => {
          if (current.readyState !== current.OPEN) return;
          current.send(
            JSON.stringify({
              type: "tool.result",
              callId: message.callId,
              ok: outcome.ok,
              output: outcome.output.slice(0, MAX_RESULT),
            }),
          );
        });
      }
    });
    current.on("close", () => {
      clearInterval(ping);
      if (stopped) return;
      log.info(`Connexion perdue : nouvel essai dans ${Math.round(delay / 1000)} s.`);
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    });
    current.on("error", (error) => log.error(`Connexion : ${error.message}`));
  };

  open();
  return {
    stop: () => {
      stopped = true;
      clearInterval(ping);
      clearTimeout(retry);
      socket?.close();
    },
  };
}
