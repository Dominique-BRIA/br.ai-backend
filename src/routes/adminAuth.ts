import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/passwords.ts";
import { newSessionToken, sha256 } from "../auth/secrets.ts";
import type { AppContext } from "../context.ts";
import { adminAccounts, adminSessions } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";

/** Durée d'une session du tableau de bord. */
const SESSION_MS = 12 * 60 * 60_000;
/** Au-delà de ces échecs en un quart d'heure, une adresse est bloquée un moment. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;

const loginBody = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

export const newAdminBody = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(12, "Au moins 12 caractères.").max(200),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: newAdminBody.shape.password,
});

/** Session du tableau de bord valable pour ce jeton, avec son compte ; `null` sinon. */
export async function findAdminSession(ctx: AppContext, token: string) {
  const [row] = await ctx.db
    .select({
      sessionId: adminSessions.id,
      adminId: adminAccounts.id,
      email: adminAccounts.email,
      name: adminAccounts.name,
    })
    .from(adminSessions)
    .innerJoin(adminAccounts, eq(adminAccounts.id, adminSessions.adminId))
    .where(
      and(
        eq(adminSessions.tokenHash, sha256(token)),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, new Date()),
        isNull(adminAccounts.disabledAt),
      ),
    );
  return row ?? null;
}

const sessionToken = (request: FastifyRequest) => {
  const header = request.headers["x-admin-session"];
  return typeof header === "string" && header.length > 0 ? header : null;
};

/**
 * Connexion de l'équipe interne au tableau de bord, par adresse et mot de passe. Les mots de
 * passe sont gardés sous forme d'empreinte scrypt ; une adresse qui accumule les échecs est
 * bloquée un quart d'heure.
 */
export function adminAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const failures = new Map<string, number[]>();
  const recentFailures = (email: string) => {
    const since = Date.now() - FAILURE_WINDOW_MS;
    const list = (failures.get(email) ?? []).filter((at) => at > since);
    failures.set(email, list);
    return list;
  };

  app.post("/admin-auth/login", async (request) => {
    const { email, password } = parse(loginBody, request.body);
    if (recentFailures(email).length >= MAX_FAILURES) {
      throw new HttpError(429, "too_many_attempts", "Trop d'essais. Réessayez dans un quart d'heure.");
    }
    const [account] = await ctx.db.select().from(adminAccounts).where(eq(adminAccounts.email, email));
    const valid = account && !account.disabledAt && (await verifyPassword(password, account.passwordHash));
    if (!account || !valid) {
      recentFailures(email).push(Date.now());
      throw new HttpError(401, "unauthenticated", "Adresse ou mot de passe incorrect.");
    }
    failures.delete(email);
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await ctx.db.insert(adminSessions).values({ adminId: account.id, tokenHash: sha256(token), expiresAt });
    await ctx.db
      .update(adminAccounts)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminAccounts.id, account.id));
    return { token, expiresAt: expiresAt.toISOString(), admin: { email: account.email, name: account.name } };
  });

  app.get("/admin-auth/me", async (request) => {
    const token = sessionToken(request);
    const session = token ? await findAdminSession(ctx, token) : null;
    if (!session) throw new HttpError(401, "unauthenticated", "Connexion requise.");
    return { admin: { id: session.adminId, email: session.email, name: session.name } };
  });

  /** Change son mot de passe ; les autres sessions du compte sont fermées. */
  app.post("/admin-auth/password", async (request) => {
    const token = sessionToken(request);
    const session = token ? await findAdminSession(ctx, token) : null;
    if (!session) throw new HttpError(401, "unauthenticated", "Connexion requise.");
    const { currentPassword, newPassword } = parse(changePasswordBody, request.body);
    const [account] = await ctx.db.select().from(adminAccounts).where(eq(adminAccounts.id, session.adminId));
    if (!account || !(await verifyPassword(currentPassword, account.passwordHash))) {
      throw new HttpError(403, "forbidden", "Le mot de passe actuel est incorrect.");
    }
    await ctx.db
      .update(adminAccounts)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(adminAccounts.id, account.id));
    await ctx.db
      .update(adminSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(adminSessions.adminId, account.id),
          isNull(adminSessions.revokedAt),
          ne(adminSessions.id, session.sessionId),
        ),
      );
    return { ok: true };
  });

  app.post("/admin-auth/logout", async (request, reply) => {
    const token = sessionToken(request);
    if (token) {
      await ctx.db
        .update(adminSessions)
        .set({ revokedAt: new Date() })
        .where(eq(adminSessions.tokenHash, sha256(token)));
    }
    return reply.code(204).send();
  });
}

/** Comptes de l'équipe interne, gérés depuis le tableau de bord (ou le script d'ajout). */
export function adminAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/admin/admins", async () => {
    const rows = await ctx.db
      .select({
        id: adminAccounts.id,
        email: adminAccounts.email,
        name: adminAccounts.name,
        lastLoginAt: adminAccounts.lastLoginAt,
        disabledAt: adminAccounts.disabledAt,
        createdAt: adminAccounts.createdAt,
      })
      .from(adminAccounts)
      .orderBy(adminAccounts.createdAt);
    return {
      admins: rows.map((row) => ({
        ...row,
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        disabledAt: row.disabledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.post("/admin/admins", async (request, reply) => {
    const { email, name, password } = parse(newAdminBody, request.body);
    const [existing] = await ctx.db
      .select({ id: adminAccounts.id })
      .from(adminAccounts)
      .where(eq(adminAccounts.email, email));
    if (existing)
      throw new HttpError(
        409,
        "invalid_request",
        "Un compte d'administration existe déjà pour cette adresse.",
      );
    await ctx.db.insert(adminAccounts).values({ email, name, passwordHash: await hashPassword(password) });
    return reply.code(201).send({ ok: true });
  });

  /** Désactive un compte (ses sessions cessent aussitôt de valoir) ou le réactive. */
  app.patch("/admin/admins/:id", async (request) => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    const { disabled } = parse(z.object({ disabled: z.boolean() }), request.body);
    if (disabled) {
      // Personne ne doit pouvoir se fermer la porte : ni sur son propre compte, ni sur le dernier actif.
      const token = request.headers["x-admin-session"];
      const self = typeof token === "string" && token ? await findAdminSession(ctx, token) : null;
      if (self?.adminId === id) {
        throw new HttpError(409, "forbidden", "Vous ne pouvez pas désactiver votre propre compte.");
      }
      const active = await ctx.db
        .select({ id: adminAccounts.id })
        .from(adminAccounts)
        .where(isNull(adminAccounts.disabledAt));
      if (active.length === 1 && active[0]?.id === id) {
        throw new HttpError(409, "forbidden", "C'est le dernier compte actif : il doit le rester.");
      }
    }
    const [row] = await ctx.db
      .update(adminAccounts)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(eq(adminAccounts.id, id))
      .returning({ id: adminAccounts.id });
    if (!row) throw new HttpError(404, "not_found", "Compte introuvable.");
    return { ok: true };
  });
}
