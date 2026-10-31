import { WS_PATH } from "@br-ia/protocol";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { Database } from "./db/client.js";
import { ConnectionRegistry, handleConnection } from "./ws/connection.js";

export const SERVER_VERSION = "0.1.0";

export interface AppOptions {
  database: Database;
  logger?: FastifyServerOptions["logger"];
  helloTimeoutMs?: number;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  const registry = new ConnectionRegistry();

  await app.register(websocket);

  app.get("/health", async (_request, reply) => {
    const databaseOk = await options.database.ping();
    return reply.code(databaseOk ? 200 : 503).send({
      status: databaseOk ? "ok" : "degraded",
      version: SERVER_VERSION,
      database: databaseOk ? "ok" : "unreachable",
      machines: registry.size,
    });
  });

  app.get(WS_PATH, { websocket: true }, (socket) => {
    handleConnection(socket, {
      registry,
      serverVersion: SERVER_VERSION,
      log: app.log,
      helloTimeoutMs: options.helloTimeoutMs,
    });
  });

  return app;
}
