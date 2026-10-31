import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { sessions } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { newSessionToken, sha256 } from "./secrets.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Membre authentifié par le jeton de session. */
    userId: string;
  }
}

export async function openSession(ctx: AppContext, userId: string, machineId: string): Promise<string> {
  const token = newSessionToken();
  await ctx.db.insert(sessions).values({ userId, machineId, tokenHash: sha256(token) });
  return token;
}

/** Renvoie le membre et la session correspondant au jeton, ou `null` si le jeton est inconnu ou révoqué. */
export async function findSession(ctx: AppContext, token: string) {
  const [session] = await ctx.db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt)));
  if (!session) return null;
  await ctx.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, session.id));
  return session;
}

export async function revokeSession(ctx: AppContext, token: string): Promise<void> {
  await ctx.db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, sha256(token)));
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/** Ajoute aux routes de ce contexte l'obligation d'être connecté. */
export function requireAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest("userId", "");
  app.addHook("preHandler", async (request) => {
    const token = bearerToken(request);
    const session = token ? await findSession(ctx, token) : null;
    if (!session) throw new HttpError(401, "unauthenticated", "Connexion requise.");
    request.userId = session.userId;
  });
}
