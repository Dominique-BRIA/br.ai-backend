import { deleteAccountBody, type SessionsResponse, type User, updateMeBody } from "@br-ia/protocol";
import { and, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { sessions, teamMembers, teams, users } from "../db/schema.ts";
import { HttpError, notFound, parse } from "../http/errors.ts";
import { teammateIds } from "../services/access.ts";

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
