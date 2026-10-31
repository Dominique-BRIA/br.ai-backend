import type { Team, Workspace } from "@br-ia/protocol";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { projects, sessions, teamMembers, teams, users } from "../db/schema.ts";
import { notFound } from "../http/errors.ts";

/** L'espace de travail d'un membre : son compte, ses équipes, leurs membres et leurs projets actifs. */
export async function buildWorkspace(ctx: AppContext, userId: string): Promise<Workspace> {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound("Compte introuvable.");

  const myTeams = await ctx.db
    .select({ id: teams.id, name: teams.name, myRole: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(asc(teams.name));

  const teamIds = myTeams.map((team) => team.id);
  const [memberRows, projectRows] =
    teamIds.length === 0
      ? [[], []]
      : await Promise.all([
          ctx.db
            .select({
              teamId: teamMembers.teamId,
              userId: users.id,
              displayName: users.displayName,
              role: teamMembers.role,
            })
            .from(teamMembers)
            .innerJoin(users, eq(users.id, teamMembers.userId))
            .where(inArray(teamMembers.teamId, teamIds))
            .orderBy(asc(users.displayName)),
          ctx.db
            .select({ id: projects.id, teamId: projects.teamId, name: projects.name })
            .from(projects)
            .where(and(inArray(projects.teamId, teamIds), isNull(projects.archivedAt)))
            .orderBy(asc(projects.name)),
        ]);

  // Dernière activité de chaque membre, toutes machines confondues.
  const memberIds = [...new Set(memberRows.map((member) => member.userId))];
  const lastSeen = new Map(
    memberIds.length === 0
      ? []
      : (
          await ctx.db
            .select({ userId: sessions.userId, at: max(sessions.lastSeenAt) })
            .from(sessions)
            .where(inArray(sessions.userId, memberIds))
            .groupBy(sessions.userId)
        ).map((row) => [row.userId, row.at]),
  );

  return {
    user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale },
    teams: myTeams.map(
      (team): Team => ({
        ...team,
        members: memberRows
          .filter((member) => member.teamId === team.id)
          .map(({ userId, displayName, role }) => ({
            userId,
            displayName,
            role,
            online: ctx.hub.isOnline(userId),
            lastSeenAt: lastSeen.get(userId)?.toISOString() ?? null,
          })),
        projects: projectRows.filter((project) => project.teamId === team.id),
      }),
    ),
  };
}

export async function buildTeam(ctx: AppContext, userId: string, teamId: string): Promise<Team> {
  const workspace = await buildWorkspace(ctx, userId);
  const team = workspace.teams.find((candidate) => candidate.id === teamId);
  if (!team) throw notFound("Équipe introuvable.");
  return team;
}
