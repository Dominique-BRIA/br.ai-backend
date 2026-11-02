import { createPromoBody } from "@br-ia/protocol";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { betaRequests, promoCodes } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";
import { betaInviteMail } from "../mail/templates.ts";
import { createPromoCodes } from "../services/promo.ts";

const requestBody = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
});
const idParams = z.object({ id: z.uuid() });
/** Ce que le code offre à l'équipe, choisi dans le tableau de bord au moment de l'envoi. */
const inviteBody = z.object({
  credits: z.number().int().min(1).max(10_000_000),
  months: z.number().int().min(1).max(36),
});

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
  /** Un code à usage unique pour cette adresse. */
  const createInvite = async (email: string, offer: z.output<typeof inviteBody>) => {
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    const [code] = await createPromoCodes(
      ctx,
      createPromoBody.parse({
        kind: "credits",
        credits: offer.credits,
        durationMonths: offer.months,
        maxUses: 1,
        expiresAt: expiresAt.toISOString(),
        sort: "unique",
        note: email,
      }),
    );
    if (!code) throw new Error("Code non créé.");
    return { code, expiresAt };
  };

  app.get("/admin/beta-requests", async () => {
    const rows = await ctx.db
      .select({ request: betaRequests, uses: promoCodes.usesCount })
      .from(betaRequests)
      .leftJoin(promoCodes, eq(promoCodes.code, betaRequests.inviteCode))
      .orderBy(desc(betaRequests.createdAt))
      .limit(500);
    return {
      requests: rows.map(({ request, uses }) => ({
        id: request.id,
        email: request.email,
        inviteCode: request.inviteCode,
        invitedAt: request.invitedAt?.toISOString() ?? null,
        /** Le code a servi : une équipe a reçu ses crédits. */
        joined: (uses ?? 0) > 0,
        createdAt: request.createdAt.toISOString(),
      })),
    };
  });

  app.post("/admin/beta-requests/:id/invite", async (request) => {
    const { id } = parse(idParams, request.params);
    const [row] = await ctx.db.select().from(betaRequests).where(eq(betaRequests.id, id));
    if (!row) throw new HttpError(404, "not_found", "Demande introuvable.");
    if (row.inviteCode) throw new HttpError(409, "already_invited", "Cette adresse a déjà reçu un code.");

    const offer = parse(inviteBody, request.body);
    const { code, expiresAt } = await createInvite(row.email, offer);
    try {
      await ctx.mailer.send(betaInviteMail(row.email, code, expiresAt, offer));
    } catch {
      // Sans e-mail parti, le code ne sert à personne : la demande reste à traiter.
      await ctx.db.delete(promoCodes).where(eq(promoCodes.code, code));
      throw new HttpError(502, "mail_failed", "L'e-mail d'invitation n'a pas pu partir. Réessayez.");
    }
    const invitedAt = new Date();
    await ctx.db.update(betaRequests).set({ inviteCode: code, invitedAt }).where(eq(betaRequests.id, id));
    return { code, invitedAt: invitedAt.toISOString() };
  });

  /** Renvoie le même code tant qu'il est valable ; un code expiré est remplacé par un nouveau. */
  app.post("/admin/beta-requests/:id/resend", async (request) => {
    const { id } = parse(idParams, request.params);
    const [row] = await ctx.db.select().from(betaRequests).where(eq(betaRequests.id, id));
    if (!row) throw new HttpError(404, "not_found", "Demande introuvable.");
    if (!row.inviteCode)
      throw new HttpError(409, "invalid_request", "Cette adresse n'a pas encore été invitée.");
    const [invite] = await ctx.db.select().from(promoCodes).where(eq(promoCodes.code, row.inviteCode));
    if (invite && invite.maxUses !== null && invite.usesCount >= invite.maxUses) {
      throw new HttpError(409, "already_invited", "Ce code a déjà été utilisé.");
    }

    // Un code encore valable repart tel quel ; sinon il en faut un nouveau, avec son montant.
    const valid = invite?.expiresAt && invite.expiresAt.getTime() > Date.now() ? invite : null;
    const offer = valid
      ? { credits: valid.credits ?? 0, months: valid.durationMonths ?? 1 }
      : parse(inviteBody, request.body);
    const { code, expiresAt } = valid?.expiresAt
      ? { code: valid.code, expiresAt: valid.expiresAt }
      : await createInvite(row.email, offer);
    try {
      await ctx.mailer.send(betaInviteMail(row.email, code, expiresAt, offer));
    } catch {
      if (code !== row.inviteCode) await ctx.db.delete(promoCodes).where(eq(promoCodes.code, code));
      throw new HttpError(502, "mail_failed", "L'e-mail d'invitation n'a pas pu partir. Réessayez.");
    }
    const invitedAt = new Date();
    await ctx.db.update(betaRequests).set({ inviteCode: code, invitedAt }).where(eq(betaRequests.id, id));
    return { code, invitedAt: invitedAt.toISOString() };
  });
}
