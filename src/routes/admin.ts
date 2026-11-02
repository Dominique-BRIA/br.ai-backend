import { timingSafeEqual } from "node:crypto";
import { createPromoBody, type PromoCode } from "@br-ia/protocol";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ModelChoice } from "../ai/client.ts";
import { allowed, requiredPermission } from "../auth/adminPermissions.ts";
import type { AppContext } from "../context.ts";
import { promoCodes } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";
import { auditDetail, describeAction, recordAudit } from "../services/audit.ts";
import { createPromoCodes, toPromoCode } from "../services/promo.ts";
import { adminAccountRoutes, findAdminSession } from "./adminAuth.ts";
import { betaRequestAdminRoutes } from "./beta.ts";
import { dashboardRoutes } from "./dashboard.ts";
import { insightRoutes } from "./insights.ts";

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
  // Qui fait la requête, pour le journal : un compte de l'équipe interne, ou le jeton du serveur.
  const actors = new WeakMap<FastifyRequest, { id: string | null; name: string }>();

  app.addHook("preHandler", async (request) => {
    // Une session ouverte par un compte de l'équipe interne (tableau de bord)…
    const session = request.headers["x-admin-session"];
    const account = typeof session === "string" && session ? await findAdminSession(ctx, session) : null;
    if (account) {
      // Chaque section du tableau de bord demande son autorisation.
      const required = requiredPermission(request.method, request.routeOptions.url ?? request.url);
      if (!allowed(account.permissions, required, request.method)) {
        throw new HttpError(
          403,
          "forbidden",
          "Votre compte n'a pas accès à cette partie du tableau de bord.",
        );
      }
      actors.set(request, { id: account.adminId, name: account.name });
      return;
    }
    // … ou le jeton d'administration du serveur (scripts, premier compte).
    const given = request.headers["x-admin-token"];
    if (!adminToken || typeof given !== "string" || !sameSecret(given, adminToken)) {
      throw new HttpError(401, "unauthenticated", "Accès réservé à l'équipe interne.");
    }
    actors.set(request, { id: null, name: "Jeton du serveur" });
  });

  // Chaque modification réussie entre au journal ; les lectures et les refus n'y vont pas.
  app.addHook("onResponse", async (request, reply) => {
    const actor = actors.get(request);
    if (!actor || request.method === "GET" || reply.statusCode >= 400) return;
    const params = request.params as { id?: string } | undefined;
    await recordAudit(ctx, {
      adminId: actor.id,
      actor: actor.name,
      action: describeAction(request.method, request.routeOptions.url ?? request.url),
      request,
      statusCode: reply.statusCode,
      targetId: params?.id ?? null,
      detail: auditDetail(request.body),
    });
  });

  adminAccountRoutes(app, ctx);
  betaRequestAdminRoutes(app, ctx);

  dashboardRoutes(app, ctx, chains);
  insightRoutes(app, ctx);

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
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
