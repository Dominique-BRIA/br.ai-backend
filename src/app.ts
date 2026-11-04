import { type MaintenanceStatus, WS_PATH } from "@br-ia/protocol";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";
import { Kitchen } from "./agents/cuisinier.ts";
import { ServeurAgent } from "./agents/serveur.ts";
import { type Ai, AiClient, type ModelChoice } from "./ai/client.ts";
import { bearerToken, findSession, requireAuth } from "./auth/sessions.ts";
import type { AppContext } from "./context.ts";
import type { Database } from "./db/client.ts";
import { registerErrorHandler } from "./http/errors.ts";
import { LogMailer, type Mailer } from "./mail/mailer.ts";
import { RealtimeHub } from "./realtime/hub.ts";
import { RealtimeTickets } from "./realtime/tickets.ts";
import { adminRoutes } from "./routes/admin.ts";
import { adminAuthRoutes } from "./routes/adminAuth.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { authRoutes } from "./routes/auth.ts";
import { betaRequestRoutes } from "./routes/beta.ts";
import { githubAppRoutes, githubPublicRoutes } from "./routes/github.ts";
import { meRoutes } from "./routes/me.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { messageRoutes } from "./routes/messages.ts";
import { orderRoutes } from "./routes/orders.ts";
import { secretRoutes } from "./routes/secrets.ts";
import { teamRoutes } from "./routes/teams.ts";
import type { Vault } from "./secrets/vault.ts";
import type { GitHubApp } from "./services/githubApp.ts";
import { getMaintenance, maintenanceStatus, resumeMaintenance } from "./services/maintenance.ts";
import { MemoryStorage, type Storage } from "./storage/storage.ts";
import { handleConnection } from "./ws/connection.ts";

export const SERVER_VERSION = "0.5.0";

export interface AppOptions {
  database: Database;
  logger?: FastifyServerOptions["logger"];
  /** Par défaut, les e-mails sont écrits dans le journal. */
  mailer?: Mailer;
  /** Par défaut, les fichiers sont gardés en mémoire (tests). */
  storage?: Storage;
  adminToken?: string;
  /** Chiffrement du coffre de secrets ; sans lui, le coffre est fermé. */
  vault?: Vault | null;
  /** Modèles de l'agent serveur, dans l'ordre d'essai. Vide : agent désactivé. */
  serveurChain?: ModelChoice[];
  /** Modèles du cuisinier, dans l'ordre d'essai. Vide : cuisinier désactivé. */
  cuisinierChain?: ModelChoice[];
  /** Client d'IA ; par défaut, appels réels aux fournisseurs (les tests en fournissent un faux). */
  ai?: Ai;
  /** Application GitHub ; sans elle, tout passe par la connexion de chaque membre. */
  githubApp?: GitHubApp | null;
  helloTimeoutMs?: number;
  /** Codes de connexion par heure et par adresse pour de nouveaux comptes. */
  newAccountCodesPerHour?: number;
  /** Clé du site, qui lui permet de transmettre l'adresse de ses visiteurs. */
  siteRelayKey?: string;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  const ctx: AppContext = {
    db: options.database.db,
    hub: new RealtimeHub(),
    mailer: options.mailer ?? new LogMailer(app.log),
    storage: options.storage ?? new MemoryStorage(),
    log: app.log,
    onMemberMessage: () => {},
    summarize: async () => null,
    vault: options.vault ?? null,
    kitchen: { onMachineStatus() {}, onToolResult() {}, onConnectionClosed() {} },
  };
  const ai = options.ai ?? new AiClient(ctx);
  const cuisinierChain = options.cuisinierChain ?? [];
  const kitchen =
    cuisinierChain.length > 0 ? new Kitchen(ctx, ai, cuisinierChain, options.githubApp ?? null) : null;
  if (kitchen) ctx.kitchen = kitchen;
  else app.log.warn("Cuisinier désactivé : aucune clé d'IA configurée pour lui.");
  const serveurChain = options.serveurChain ?? [];
  const serveur = serveurChain.length > 0 ? new ServeurAgent(ctx, ai, serveurChain, kitchen) : null;
  if (serveur) {
    ctx.onMemberMessage = (message, teamId) => void serveur.onMemberMessage(message, teamId);
    ctx.summarize = (request) => serveur.summarize(request);
  } else app.log.warn("Agent serveur désactivé : aucune clé d'IA configurée.");

  const tickets = new RealtimeTickets();
  await resumeMaintenance(ctx);
  registerErrorHandler(app);
  await app.register(websocket);

  app.get("/status", async (request): Promise<{ maintenance: MaintenanceStatus }> => {
    // Avec une session, on dit aussi si ce compte garde l'accès pendant la maintenance.
    const token = bearerToken(request);
    const session = token ? await findSession(ctx, token).catch(() => null) : null;
    return { maintenance: maintenanceStatus(await getMaintenance(ctx), session?.email) };
  });

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
    handleConnection(socket, {
      ctx,
      serverVersion: SERVER_VERSION,
      helloTimeoutMs: options.helloTimeoutMs,
      tickets,
    });
  });

  await app.register(async (scope) =>
    authRoutes(scope, ctx, options.newAccountCodesPerHour, options.siteRelayKey),
  );
  await app.register(async (scope) => adminAuthRoutes(scope, ctx));
  await app.register(async (scope) => betaRequestRoutes(scope, ctx));
  await app.register(async (scope) => {
    requireAuth(scope, ctx);
    teamRoutes(scope, ctx);
    messageRoutes(scope, ctx);
    attachmentRoutes(scope, ctx);
    meRoutes(scope, ctx);
    secretRoutes(scope, ctx);
    memoryRoutes(scope, ctx);
    orderRoutes(scope, ctx, kitchen, options.githubApp ?? null);
    /** Ticket de connexion temps réel pour la plateforme web. */
    scope.post("/realtime/ticket", async (request) => tickets.issue(request.sessionId));
    githubAppRoutes(scope, ctx, options.githubApp ?? null);
  });
  const { githubApp } = options;
  if (githubApp) await app.register(async (scope) => githubPublicRoutes(scope, ctx, githubApp, kitchen));
  await app.register(async (scope) =>
    adminRoutes(scope, ctx, options.adminToken, { serveur: serveurChain, cuisinier: cuisinierChain }),
  );

  // Pas d'Object.assign sur l'instance Fastify : elle se comporte comme une promesse,
  // et l'attendre ferait perdre les propriétés ajoutées dans les types.
  return { app, ctx, serveur, kitchen };
}
