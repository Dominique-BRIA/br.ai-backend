import { randomUUID } from "node:crypto";
import {
  type ErrorCode,
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import { findSession } from "../auth/sessions.ts";
import type { AppContext } from "../context.ts";
import { sessions } from "../db/schema.ts";
import type { LiveConnection } from "../realtime/hub.ts";
import { teammateIds } from "../services/access.ts";

/** Codes de fermeture WebSocket propres à br.ia (plage 4000-4999 réservée aux applications). */
export const CLOSE_CODES = {
  unauthenticated: 4401,
  protocolError: 4400,
  helloTimeout: 4408,
  protocolMismatch: 4426,
} as const;

/**
 * Gère une connexion d'extension : le premier message doit être `hello`,
 * envoyé dans le délai imparti, avec une version de protocole compatible
 * et un jeton de session valable.
 */
export function handleConnection(
  socket: WebSocket,
  options: { ctx: AppContext; serverVersion: string; helloTimeoutMs?: number },
): void {
  const { ctx, serverVersion } = options;
  const connectionId = randomUUID();
  let live: LiveConnection | null = null;
  let greeting = false;

  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const fail = (code: ErrorCode, message: string, closeCode: number) => {
    send({ type: "error", code, message });
    socket.close(closeCode, code);
  };

  const helloTimer = setTimeout(() => {
    fail("hello_timeout", "La machine ne s'est pas présentée à temps.", CLOSE_CODES.helloTimeout);
  }, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

  /** Prévient les coéquipiers (sauf le membre lui-même) qu'il vient d'arriver ou de partir. */
  const announce = async (userId: string, online: boolean) => {
    const recipients = (await teammateIds(ctx, userId)).filter((id) => id !== userId);
    ctx.hub.sendTo(recipients, { type: "presence.changed", userId, online });
  };

  // Les erreurs des traitements asynchrones sont journalisées, jamais laissées sans suite.
  const safely = (task: () => Promise<void>) => {
    task().catch((error: unknown) =>
      ctx.log.error({ err: error, connectionId }, "erreur de connexion temps réel"),
    );
  };

  socket.on("message", (data) => safely(() => onMessage(data.toString())));
  socket.on("close", () => safely(onClose));

  async function onMessage(raw: string) {
    const message = parseClientMessage(raw);
    if (!message) {
      fail("invalid_message", "Message illisible.", CLOSE_CODES.protocolError);
      return;
    }

    if (!live) {
      if (greeting) return;
      if (message.type !== "hello") {
        fail("hello_expected", "Le premier message doit être « hello ».", CLOSE_CODES.protocolError);
        return;
      }
      greeting = true;
      clearTimeout(helloTimer);
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        fail(
          "protocol_mismatch",
          `Version du protocole ${message.protocolVersion} non prise en charge (attendue : ${PROTOCOL_VERSION}). Mettez l'extension à jour.`,
          CLOSE_CODES.protocolMismatch,
        );
        return;
      }
      const session = await findSession(ctx, message.token);
      if (!session) {
        fail(
          "unauthenticated",
          "Session inconnue ou expirée. Reconnectez-vous.",
          CLOSE_CODES.unauthenticated,
        );
        return;
      }
      if (socket.readyState !== socket.OPEN) return;

      await ctx.db
        .update(sessions)
        .set({ os: message.machine.os, editor: message.machine.editor })
        .where(eq(sessions.id, session.id));
      live = {
        connectionId,
        userId: session.userId,
        sessionId: session.id,
        machine: message.machine,
        send,
        close: () => socket.close(CLOSE_CODES.unauthenticated, "session_revoked"),
      };
      const firstMachine = ctx.hub.add(live);
      ctx.log.info({ connectionId, userId: session.userId, machine: message.machine }, "machine connectée");
      send({ type: "welcome", protocolVersion: PROTOCOL_VERSION, serverVersion, connectionId });
      if (firstMachine) await announce(session.userId, true);
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
  }

  async function onClose() {
    clearTimeout(helloTimer);
    if (!live) return;
    const lastMachine = ctx.hub.remove(live);
    ctx.log.info({ connectionId }, "machine déconnectée");
    if (lastMachine) await announce(live.userId, false);
  }
}
