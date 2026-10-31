import type { TeamRole } from "@br-ia/protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { projects, teamMembers } from "../db/schema.ts";
import { forbidden, notFound } from "../http/errors.ts";

/**
 * Vérifications d'accès. Une équipe ou un projet dont on n'est pas membre
 * est signalé comme introuvable, pour ne pas révéler son existence.
 */

export async function roleIn(ctx: AppContext, userId: string, teamId: string): Promise<TeamRole | null> {
  const [row] = await ctx.db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return row?.role ?? null;
}

export async function requireMember(ctx: AppContext, userId: string, teamId: string): Promise<TeamRole> {
  const role = await roleIn(ctx, userId, teamId);
  if (!role) throw notFound("Équipe introuvable.");
  return role;
}

export async function requireChef(ctx: AppContext, userId: string, teamId: string): Promise<void> {
  const role = await requireMember(ctx, userId, teamId);
  if (role !== "chef") throw forbidden("Réservé au chef d'équipe.");
}

/** Projet non archivé d'une équipe dont le membre fait partie. */
export async function requireProject(ctx: AppContext, userId: string, projectId: string) {
  const [project] = await ctx.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)));
  if (!project) throw notFound("Projet introuvable.");
  const role = await roleIn(ctx, userId, project.teamId);
  if (!role) throw notFound("Projet introuvable.");
  return { project, role };
}

export async function memberIds(ctx: AppContext, teamId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return rows.map((row) => row.userId);
}

/** Tous les membres qui partagent au moins une équipe avec ce membre (lui compris). */
export async function teammateIds(ctx: AppContext, userId: string): Promise<string[]> {
  const myTeams = ctx.db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  const rows = await ctx.db
    .selectDistinct({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(inArray(teamMembers.teamId, myTeams));
  return rows.map((row) => row.userId);
}
