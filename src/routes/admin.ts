import { timingSafeEqual } from "node:crypto";
import { createPromoBody, type PromoCode } from "@br-ia/protocol";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelChoice } from "../ai/client.ts";
import { newInvitationCode } from "../auth/secrets.ts";
import type { AppContext } from "../context.ts";
import { betaInvites, promoCodes } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";
import { createPromoCodes, toPromoCode } from "../services/promo.ts";
import { adminAccountRoutes, findAdminSession } from "./adminAuth.ts";
import { dashboardRoutes } from "./dashboard.ts";

const createBetaInviteBody = z.object({
  maxUses: z.number().int().min(1).max(1000).default(1),
  note: z.string().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/**
 * Routes de l'équipe interne, protégées par le jeton `ADMIN_TOKEN`.
 * Provisoire : le tableau de bord d'administration (lot 6) les remplacera.
 */
export function adminRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  adminToken: string | undefined,
  chains: { serveur: ModelChoice[]; cuisinier: ModelChoice[] } = { serveur: [], cuisinier: [] },
): void {
  app.addHook("preHandler", async (request) => {
    // Une session ouverte par un compte de l'équipe interne (tableau de bord)…
    const session = request.headers["x-admin-session"];
    if (typeof session === "string" && session && (await findAdminSession(ctx, session))) return;
    // … ou le jeton d'administration du serveur (scripts, premier compte).
    const given = request.headers["x-admin-token"];
    if (!adminToken || typeof given !== "string" || !sameSecret(given, adminToken)) {
      throw new HttpError(401, "unauthenticated", "Accès réservé à l'équipe interne.");
    }
  });

  adminAccountRoutes(app, ctx);

  dashboardRoutes(app, ctx, chains);

  app.get("/admin/promo-codes", async (): Promise<{ codes: PromoCode[] }> => {
    const rows = await ctx.db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt)).limit(500);
    return { codes: rows.map(toPromoCode) };
  });

  /** Un code, ou un lot de codes uniques. */
  app.post("/admin/promo-codes", async (request): Promise<{ codes: string[] }> => {
    return { codes: await createPromoCodes(ctx, parse(createPromoBody, request.body)) };
  });

  app.patch("/admin/promo-codes/:id", async (request): Promise<{ code: PromoCode }> => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    const { disabled } = parse(z.object({ disabled: z.boolean() }), request.body);
    const [row] = await ctx.db
      .update(promoCodes)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(eq(promoCodes.id, id))
      .returning();
    if (!row) throw new HttpError(404, "not_found", "Code introuvable.");
    return { code: toPromoCode(row) };
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
