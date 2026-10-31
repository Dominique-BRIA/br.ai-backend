import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newInvitationCode } from "../auth/secrets.ts";
import type { AppContext } from "../context.ts";
import { betaInvites } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";

const createBetaInviteBody = z.object({
  maxUses: z.number().int().min(1).max(1000).default(1),
  note: z.string().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/**
 * Routes de l'équipe interne, protégées par le jeton `ADMIN_TOKEN`.
 * Provisoire : le tableau de bord d'administration (lot 6) les remplacera.
 */
export function adminRoutes(app: FastifyInstance, ctx: AppContext, adminToken: string | undefined): void {
  app.addHook("preHandler", async (request) => {
    const given = request.headers["x-admin-token"];
    if (!adminToken || typeof given !== "string" || !sameSecret(given, adminToken)) {
      throw new HttpError(401, "unauthenticated", "Accès réservé à l'équipe interne.");
    }
  });

  app.post("/admin/beta-invites", async (request) => {
    const { maxUses, note, expiresInDays } = parse(createBetaInviteBody, request.body ?? {});
    const code = newInvitationCode("BETA");
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
    await ctx.db.insert(betaInvites).values({ code, maxUses, note, expiresAt });
    return { code, maxUses, expiresAt: expiresAt?.toISOString() ?? null };
  });
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
