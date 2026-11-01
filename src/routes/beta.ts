import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newInvitationCode } from "../auth/secrets.ts";
import type { AppContext } from "../context.ts";
import { betaInvites, betaRequests } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";
import { betaInviteMail } from "../mail/templates.ts";

const requestBody = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
});
const idParams = z.object({ id: z.uuid() });

/** Une adresse IP peut laisser au plus 5 demandes par heure. */
const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 5;
/** Le code envoyé reste valable 30 jours. */
const INVITE_DAYS = 30;

/**
 * Demande d'accès à la bêta, depuis la page d'accueil du site. La réponse est la même que
 * l'adresse soit nouvelle, déjà inscrite ou déjà invitée : rien n'est révélé sur les comptes.
 */
export function betaRequestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const recent = new Map<string, number[]>();

  app.post("/beta-requests", async (request) => {
    // La demande passe par le site : l'adresse du visiteur est celle qu'il a relayée.
    const forwarded = request.headers["x-forwarded-for"];
    const visitor = (typeof forwarded === "string" && forwarded.split(",")[0]?.trim()) || request.ip;
    const now = Date.now();
    const times = (recent.get(visitor) ?? []).filter((time) => now - time < WINDOW_MS);
    if (times.length >= MAX_PER_WINDOW) {
      throw new HttpError(429, "too_many_requests", "Trop de demandes. Réessayez dans une heure.");
    }
    recent.set(visitor, [...times, now]);

    const { email } = parse(requestBody, request.body);
    await ctx.db.insert(betaRequests).values({ email }).onConflictDoNothing();
    return { ok: true };
  });
}

/** Les demandes, dans le tableau de bord, et l'envoi d'un code d'invitation par e-mail. */
export function betaRequestAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/admin/beta-requests", async () => {
    const rows = await ctx.db.select().from(betaRequests).orderBy(desc(betaRequests.createdAt)).limit(500);
    return {
      requests: rows.map((row) => ({
        id: row.id,
        email: row.email,
        inviteCode: row.inviteCode,
        invitedAt: row.invitedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.post("/admin/beta-requests/:id/invite", async (request) => {
    const { id } = parse(idParams, request.params);
    const [row] = await ctx.db.select().from(betaRequests).where(eq(betaRequests.id, id));
    if (!row) throw new HttpError(404, "not_found", "Demande introuvable.");
    if (row.inviteCode) throw new HttpError(409, "already_invited", "Cette adresse a déjà reçu un code.");

    const code = newInvitationCode("BETA");
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    await ctx.db.insert(betaInvites).values({ code, maxUses: 1, note: row.email, expiresAt });
    try {
      await ctx.mailer.send(betaInviteMail(row.email, code, expiresAt));
    } catch {
      // Sans e-mail parti, le code ne sert à personne : la demande reste à traiter.
      await ctx.db.delete(betaInvites).where(eq(betaInvites.code, code));
      throw new HttpError(502, "mail_failed", "L'e-mail d'invitation n'a pas pu partir. Réessayez.");
    }
    const invitedAt = new Date();
    await ctx.db.update(betaRequests).set({ inviteCode: code, invitedAt }).where(eq(betaRequests.id, id));
    return { code, invitedAt: invitedAt.toISOString() };
  });
}
