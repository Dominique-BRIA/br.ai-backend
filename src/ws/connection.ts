import { randomUUID } from "node:crypto";
import {
  type ErrorCode,
  HELLO_TIMEOUT_MS,
  type MachineInfo,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from "@br-ia/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";

/** Codes de fermeture WebSocket propres à br.ia (plage 4000-4999 réservée aux applications). */
export const CLOSE_CODES = {
  protocolError: 4400,
  helloTimeout: 4408,
  protocolMismatch: 4426,
} as const;

export interface MachineConnection {
  connectionId: string;
  machine: MachineInfo;
  connectedAt: Date;
}

/** Les machines actuellement connectées, indexées par identifiant de connexion. */
export class ConnectionRegistry {
  readonly #connections = new Map<string, MachineConnection>();

  add(connection: MachineConnection): void {
    this.#connections.set(connection.connectionId, connection);
  }

  remove(connectionId: string): void {
    this.#connections.delete(connectionId);
  }

  get size(): number {
    return this.#connections.size;
  }
}

/**
 * Gère une connexion d'extension : le premier message doit être `hello`,
 * envoyé dans le délai imparti, avec une version de protocole compatible.
 */
export function handleConnection(
  socket: WebSocket,
  options: {
    registry: ConnectionRegistry;
    serverVersion: string;
    log: FastifyBaseLogger;
    helloTimeoutMs?: number;
  },
): void {
  const { registry, serverVersion, log } = options;
  const connectionId = randomUUID();
  let machine: MachineInfo | null = null;

  const send = (message: ServerMessage) => socket.send(JSON.stringify(message));
  const fail = (code: ErrorCode, message: string, closeCode: number) => {
    send({ type: "error", code, message });
    socket.close(closeCode, code);
  };

  const helloTimer = setTimeout(() => {
    fail("hello_timeout", "La machine ne s'est pas présentée à temps.", CLOSE_CODES.helloTimeout);
  }, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

  socket.on("message", (data) => {
    const message = parseClientMessage(data.toString());
    if (!message) {
      fail("invalid_message", "Message illisible.", CLOSE_CODES.protocolError);
      return;
    }

    if (!machine) {
      if (message.type !== "hello") {
        fail("hello_expected", "Le premier message doit être « hello ».", CLOSE_CODES.protocolError);
        return;
      }
      clearTimeout(helloTimer);
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        fail(
          "protocol_mismatch",
          `Version du protocole ${message.protocolVersion} non prise en charge (attendue : ${PROTOCOL_VERSION}). Mettez l'extension à jour.`,
          CLOSE_CODES.protocolMismatch,
        );
        return;
      }
      machine = message.machine;
      registry.add({ connectionId, machine, connectedAt: new Date() });
      log.info({ connectionId, machine }, "machine connectée");
      send({ type: "welcome", protocolVersion: PROTOCOL_VERSION, serverVersion, connectionId });
      return;
    }

    switch (message.type) {
      case "hello":
        fail("invalid_message", "La machine s'est déjà présentée.", CLOSE_CODES.protocolError);
        return;
      case "ping":
        send({ type: "pong", sentAt: message.sentAt });
        return;
    }
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (machine) {
      registry.remove(connectionId);
      log.info({ connectionId }, "machine déconnectée");
    }
  });
}
