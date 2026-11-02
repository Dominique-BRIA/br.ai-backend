import {
  type RequestCodeResponse,
  requestCodeBody,
  type VerifyCodeResponse,
  verifyCodeBody,
} from "@br-ia/protocol";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loginCodeHash, newLoginCode } from "../auth/secrets.ts";
import { bearerToken, openSession, revokeSession } from "../auth/sessions.ts";
import type { AppContext } from "../context.ts";
import { loginCodes, users } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";
import { loginCodeMail } from "../mail/templates.ts";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const RESEND_DELAY_MS = 60_000;

/** L'inscription est libre : cette limite empêche de s'en servir pour envoyer des e-mails en masse. */
const NEW_ACCOUNT_WINDOW_MS = 60 * 60_000;
export const NEW_ACCOUNT_CODES_PER_HOUR = 10;

export function authRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  newAccountCodesPerHour = NEW_ACCOUNT_CODES_PER_HOUR,
): void {
  const recentCodes = new Map<string, number[]>();

  const limitNewAccounts = (request: FastifyRequest) => {
    const now = Date.now();
    if (recentCodes.size > 10_000) recentCodes.clear();
    const visitor = visitorAddress(request);
    const times = (recentCodes.get(visitor) ?? []).filter((time) => now - time < NEW_ACCOUNT_WINDOW_MS);
    if (times.length >= newAccountCodesPerHour) {
      throw new HttpError(
        429,
        "signup_limited",
        "Trop de comptes créés depuis cette connexion. Réessayez dans une heure.",
      );
    }
    recentCodes.set(visitor, [...times, now]);
  };

  app.post("/auth/code", async (request): Promise<RequestCodeResponse> => {
    const { email } = parse(requestCodeBody, request.body);
    const [existing] = await ctx.db
      .select({ id: users.id, locale: users.locale, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.email, email));
    if (existing?.suspendedAt) {
      throw new HttpError(403, "account_suspended", "Ce compte est suspendu. Contactez l'équipe de <br/>.");
    }

    if (!existing) limitNewAccounts(request);

    const [recent] = await ctx.db
      .select({ createdAt: loginCodes.createdAt })
      .from(loginCodes)
      .where(eq(loginCodes.email, email))
      .orderBy(desc(loginCodes.createdAt))
      .limit(1);
    if (recent && Date.now() - recent.createdAt.getTime() < RESEND_DELAY_MS) {
      throw new HttpError(
        429,
        "too_many_requests",
        "Un code vient d'être envoyé. Réessayez dans une minute.",
      );
    }

    const code = newLoginCode();
    const [stored] = await ctx.db
      .insert(loginCodes)
      .values({
        email,
        codeHash: loginCodeHash(email, code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      })
      .returning({ id: loginCodes.id });
    try {
      await ctx.mailer.send(loginCodeMail(email, code, existing?.locale ?? "fr"));
    } catch (error) {
      // Code jamais reçu : on l'oublie, pour qu'un nouvel essai ne soit pas bloqué une minute.
      if (stored) await ctx.db.delete(loginCodes).where(eq(loginCodes.id, stored.id));
      request.log.error({ err: error }, "e-mail de connexion non envoyé");
      throw new HttpError(
        502,
        "mail_failed",
        "L'e-mail de connexion n'a pas pu partir. Réessayez dans un instant.",
      );
    }
    return { newAccount: !existing };
  });

  app.post("/auth/verify", async (request): Promise<VerifyCodeResponse> => {
    const { email, code, machineId, displayName } = parse(verifyCodeBody, request.body);

    const [pending] = await ctx.db
      .select()
      .from(loginCodes)
      .where(and(eq(loginCodes.email, email), eq(loginCodes.purpose, "login"), isNull(loginCodes.consumedAt)))
      .orderBy(desc(loginCodes.createdAt))
      .limit(1);
    if (!pending) throw new HttpError(401, "code_invalid", "Code incorrect.");
    if (pending.expiresAt.getTime() < Date.now()) {
      throw new HttpError(401, "code_expired", "Ce code a expiré. Demandez-en un nouveau.");
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      throw new HttpError(429, "too_many_attempts", "Trop d'essais. Demandez un nouveau code.");
    }
    if (pending.codeHash !== loginCodeHash(email, code)) {
      await ctx.db
        .update(loginCodes)
        .set({ attempts: sql`${loginCodes.attempts} + 1` })
        .where(eq(loginCodes.id, pending.id));
      throw new HttpError(401, "code_invalid", "Code incorrect.");
    }

    let [user] = await ctx.db.select().from(users).where(eq(users.email, email));
    if (!user && !displayName) {
      throw new HttpError(400, "display_name_required", "Indiquez le nom à afficher pour votre compte.");
    }

    await ctx.db.update(loginCodes).set({ consumedAt: new Date() }).where(eq(loginCodes.id, pending.id));

    if (!user && displayName) {
      [user] = await ctx.db.insert(users).values({ email, displayName }).returning();
      if (!user) throw new Error("Création du compte impossible.");
    }
    if (!user) throw new HttpError(401, "code_invalid", "Code incorrect.");

    const token = await openSession(ctx, user.id, machineId);
    return {
      token,
      user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale },
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = bearerToken(request);
    if (token) await revokeSession(ctx, token);
    return reply.code(204).send();
  });
}

/** Cherche une invitation valable : d'abord à la bêta, puis à une équipe. */

/**
 * L'adresse du visiteur. Azure ajoute la vraie adresse à la fin de x-forwarded-for, parfois avec
 * son port : le début de l'en-tête vient du client et peut être inventé.
 */
function visitorAddress(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const last = typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : undefined;
  return last ? last.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1") : request.ip;
}
