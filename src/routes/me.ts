import {
  changeEmailBody,
  deleteAccountBody,
  type LocalMemory,
  type NotificationsResponse,
  type SessionsResponse,
  saveLocalMemoryBody,
  sendFeedbackBody,
  type User,
  updateMeBody,
  verifyEmailBody,
} from "@br-ia/protocol";
import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loginCodeHash, newLoginCode } from "../auth/secrets.ts";
import type { AppContext } from "../context.ts";
import { feedback, localMemories, loginCodes, sessions, teamMembers, teams, users } from "../db/schema.ts";
import { HttpError, notFound, parse } from "../http/errors.ts";
import { loginCodeMail } from "../mail/templates.ts";
import { requireProject, teammateIds } from "../services/access.ts";
import { listNotifications } from "../services/notifications.ts";
import { CODE_TTL_MS, MAX_ATTEMPTS, RESEND_DELAY_MS } from "./auth.ts";

const sessionParams = z.object({ sessionId: z.uuid() });

/** Le compte du membre : profil, machines connectées, suppression. */
export function meRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.patch("/me", async (request): Promise<{ user: User }> => {
    const changes = parse(updateMeBody, request.body);
    const [user] = await ctx.db
      .update(users)
      .set({
        ...(changes.displayName !== undefined && { displayName: changes.displayName }),
        ...(changes.locale !== undefined && { locale: changes.locale }),
      })
      .where(eq(users.id, request.userId))
      .returning();
    if (!user) throw notFound("Compte introuvable.");
    // Le nouveau nom doit apparaître chez les coéquipiers.
    if (changes.displayName !== undefined) {
      ctx.hub.sendTo(await teammateIds(ctx, request.userId), { type: "workspace.changed" });
    }
    return { user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale } };
  });

  /** Changement d'adresse : un code part vers la nouvelle adresse, qui doit être libre. */
  app.post("/me/email", async (request): Promise<{ sent: true }> => {
    const { email } = parse(changeEmailBody, request.body);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, request.userId));
    if (!user) throw notFound("Compte introuvable.");
    if (user.email === email) {
      throw new HttpError(400, "invalid_request", "C'est déjà l'adresse de votre compte.");
    }
    const [taken] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken)
      throw new HttpError(409, "email_taken", "Cette adresse est déjà utilisée par un autre compte.");

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
        purpose: "email_change",
        userId: request.userId,
      })
      .returning({ id: loginCodes.id });
    try {
      await ctx.mailer.send(loginCodeMail(email, code, user.locale, "email_change"));
    } catch (error) {
      if (stored) await ctx.db.delete(loginCodes).where(eq(loginCodes.id, stored.id));
      throw error;
    }
    return { sent: true };
  });

  /** Le code reçu à la nouvelle adresse la confirme : elle remplace l'ancienne. */
  app.post("/me/email/verify", async (request): Promise<{ user: User }> => {
    const { email, code } = parse(verifyEmailBody, request.body);
    const [pending] = await ctx.db
      .select()
      .from(loginCodes)
      .where(
        and(
          eq(loginCodes.email, email),
          eq(loginCodes.purpose, "email_change"),
          eq(loginCodes.userId, request.userId),
          isNull(loginCodes.consumedAt),
        ),
      )
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
    // L'adresse a pu être prise entre-temps.
    const [taken] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken)
      throw new HttpError(409, "email_taken", "Cette adresse est déjà utilisée par un autre compte.");

    await ctx.db.update(loginCodes).set({ consumedAt: new Date() }).where(eq(loginCodes.id, pending.id));
    const [user] = await ctx.db.update(users).set({ email }).where(eq(users.id, request.userId)).returning();
    if (!user) throw notFound("Compte introuvable.");
    return { user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale } };
  });

  app.get("/me/sessions", async (request): Promise<SessionsResponse> => {
    const rows = await ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, request.userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.lastSeenAt));
    const online = ctx.hub.onlineSessions(request.userId);
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        os: row.os,
        editor: row.editor,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        current: row.id === request.sessionId,
        online: online.has(row.id),
      })),
    };
  });

  app.get(
    "/me/notifications",
    async (request): Promise<NotificationsResponse> => ({
      notifications: await listNotifications(ctx, request.userId),
    }),
  );

  /** Copie de sauvegarde de la mémoire locale (`~/.bria/memoire.md`), pour une nouvelle machine. */
  app.get("/me/local-memory", async (request): Promise<LocalMemory> => {
    const [row] = await ctx.db.select().from(localMemories).where(eq(localMemories.userId, request.userId));
    return { content: row?.content ?? "", updatedAt: row?.updatedAt.toISOString() ?? null };
  });

  app.put("/me/local-memory", async (request): Promise<LocalMemory> => {
    const { content } = parse(saveLocalMemoryBody, request.body);
    const updatedAt = new Date();
    await ctx.db
      .insert(localMemories)
      .values({ userId: request.userId, content, updatedAt })
      .onConflictDoUpdate({ target: localMemories.userId, set: { content, updatedAt } });
    return { content, updatedAt: updatedAt.toISOString() };
  });

  /** Un retour de testeur, lu dans le tableau de bord d'administration. */
  app.post("/feedback", async (request, reply) => {
    const body = parse(sendFeedbackBody, request.body);
    if (body.projectId) await requireProject(ctx, request.userId, body.projectId);
    await ctx.db.insert(feedback).values({ userId: request.userId, ...body });
    return reply.code(201).send({ ok: true });
  });

  /** Déconnecte une machine : sa session est révoquée et sa connexion temps réel fermée. */
  app.delete("/me/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = parse(sessionParams, request.params);
    const [revoked] = await ctx.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, request.userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (!revoked) throw notFound("Machine introuvable.");
    ctx.hub.closeSession(request.userId, sessionId);
    return reply.code(204).send();
  });

  /**
   * Supprime le compte. Le chef d'une équipe qui a d'autres membres doit d'abord
   * transmettre son rôle ; les équipes dont il est le seul membre sont supprimées.
   * Ses messages restent, signés « Ancien membre ».
   */
  app.delete("/me", async (request, reply) => {
    const { confirmEmail } = parse(deleteAccountBody, request.body);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, request.userId));
    if (!user) throw notFound("Compte introuvable.");
    if (user.email !== confirmEmail) {
      throw new HttpError(400, "invalid_request", "L'adresse saisie ne correspond pas à votre compte.");
    }

    const ledTeams = await ctx.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, request.userId), eq(teamMembers.role, "chef")));
    const ledTeamIds = ledTeams.map((team) => team.teamId);
    const othersByTeam =
      ledTeamIds.length === 0
        ? []
        : await ctx.db
            .select({ teamId: teamMembers.teamId, others: count() })
            .from(teamMembers)
            .where(and(inArray(teamMembers.teamId, ledTeamIds), ne(teamMembers.userId, request.userId)))
            .groupBy(teamMembers.teamId);
    if (othersByTeam.some((team) => team.others > 0)) {
      throw new HttpError(
        409,
        "chef_must_transfer",
        "Vous êtes chef d'une équipe qui a d'autres membres : transmettez d'abord votre rôle.",
      );
    }

    // Les coéquipiers sont prévenus après la suppression : leur liste de membres change.
    const teammates = (await teammateIds(ctx, request.userId)).filter((id) => id !== request.userId);

    await ctx.db.transaction(async (tx) => {
      if (ledTeamIds.length > 0) await tx.delete(teams).where(inArray(teams.id, ledTeamIds));
      await tx.delete(users).where(eq(users.id, request.userId));
    });

    for (const sessionId of ctx.hub.onlineSessions(request.userId))
      ctx.hub.closeSession(request.userId, sessionId);
    ctx.hub.sendTo(teammates, { type: "workspace.changed" });
    return reply.code(204).send();
  });
}
