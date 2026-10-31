import { WS_PATH } from "@br-ia/protocol";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";
import { requireAuth } from "./auth/sessions.ts";
import type { AppContext } from "./context.ts";
import type { Database } from "./db/client.ts";
import { registerErrorHandler } from "./http/errors.ts";
import { LogMailer, type Mailer } from "./mail/mailer.ts";
import { RealtimeHub } from "./realtime/hub.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { messageRoutes } from "./routes/messages.ts";
import { teamRoutes } from "./routes/teams.ts";
import { handleConnection } from "./ws/connection.ts";

export const SERVER_VERSION = "0.2.0";

export interface AppOptions {
  database: Database;
  logger?: FastifyServerOptions["logger"];
  /** Par défaut, les e-mails sont écrits dans le journal. */
  mailer?: Mailer;
  adminToken?: string;
  helloTimeoutMs?: number;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  const ctx: AppContext = {
    db: options.database.db,
    hub: new RealtimeHub(),
    mailer: options.mailer ?? new LogMailer(app.log),
    log: app.log,
  };

  registerErrorHandler(app);
  await app.register(websocket);

  app.get("/health", async (_request, reply) => {
    const databaseOk = await options.database.ping();
    return reply.code(databaseOk ? 200 : 503).send({
      status: databaseOk ? "ok" : "degraded",
      version: SERVER_VERSION,
      database: databaseOk ? "ok" : "unreachable",
      machines: ctx.hub.machineCount,
    });
  });

  app.get(WS_PATH, { websocket: true }, (socket) => {
    handleConnection(socket, { ctx, serverVersion: SERVER_VERSION, helloTimeoutMs: options.helloTimeoutMs });
  });

  await app.register(async (scope) => authRoutes(scope, ctx));
  await app.register(async (scope) => {
    requireAuth(scope, ctx);
    teamRoutes(scope, ctx);
    messageRoutes(scope, ctx);
  });
  await app.register(async (scope) => adminRoutes(scope, ctx, options.adminToken));

  return Object.assign(app, { ctx });
}
