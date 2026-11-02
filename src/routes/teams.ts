import {
  acceptInvitationBody,
  type CreateInvitationResponse,
  type CurrentInvitationResponse,
  createProjectBody,
  createTeamBody,
  type Project,
  type RedeemPromoResponse,
  redeemPromoBody,
  setProjectRepoBody,
  type Team,
  type TeamUsage,
  transferChefBody,
  updateProjectBody,
  type Workspace,
} from "@br-ia/protocol";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newInvitationCode, normalizeInvitationCode } from "../auth/secrets.ts";
import type { AppContext } from "../context.ts";
import { projects, teamInvitations, teamMembers, teams, users } from "../db/schema.ts";
import { forbidden, HttpError, notFound, parse } from "../http/errors.ts";
import { memberIds, requireChef, requireMember, roleIn } from "../services/access.ts";
import { requireWithinPlan, teamUsage } from "../services/credits.ts";
import { postAgentMessage } from "../services/messages.ts";
import { projectColumns, toProject } from "../services/projects.ts";
import { redeemPromo } from "../services/promo.ts";
import { revokeSecretsOnDeparture } from "../services/secrets.ts";
import { buildTeam, buildWorkspace } from "../services/workspace.ts";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;

const teamParams = z.object({ teamId: z.uuid() });
const memberParams = z.object({ teamId: z.uuid(), userId: z.uuid() });
const projectParams = z.object({ projectId: z.uuid() });

export function teamRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Prévient les membres d'une équipe que l'espace de travail a changé. */
  const notifyTeam = async (teamId: string, extraUserIds: string[] = []) => {
    ctx.hub.sendTo([...(await memberIds(ctx, teamId)), ...extraUserIds], { type: "workspace.changed" });
  };

  app.get("/workspace", async (request): Promise<Workspace> => buildWorkspace(ctx, request.userId));

  app.post("/teams", async (request): Promise<{ team: Team }> => {
    const { name } = parse(createTeamBody, request.body);
    const team = await ctx.db.transaction(async (tx) => {
      const [created] = await tx.insert(teams).values({ name }).returning();
      if (!created) throw new Error("Création de l'équipe impossible.");
      await tx.insert(teamMembers).values({ teamId: created.id, userId: request.userId, role: "chef" });
      return created;
    });
    await notifyTeam(team.id);
    return { team: await buildTeam(ctx, request.userId, team.id) };
  });

  app.post("/teams/:teamId/invitations", async (request): Promise<CreateInvitationResponse> => {
    const { teamId } = parse(teamParams, request.params);
    await requireChef(ctx, request.userId, teamId);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const code = newInvitationCode("EQP");
    await ctx.db.insert(teamInvitations).values({ teamId, code, createdBy: request.userId, expiresAt });
    return { code, expiresAt: expiresAt.toISOString() };
  });

  app.get("/teams/:teamId/invitations/current", async (request): Promise<CurrentInvitationResponse> => {
    const { teamId } = parse(teamParams, request.params);
    await requireChef(ctx, request.userId, teamId);
    const [invitation] = await ctx.db
      .select({ code: teamInvitations.code, expiresAt: teamInvitations.expiresAt })
      .from(teamInvitations)
      .where(
        and(
          eq(teamInvitations.teamId, teamId),
          isNull(teamInvitations.revokedAt),
          gt(teamInvitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(teamInvitations.createdAt))
      .limit(1);
    return {
      invitation: invitation
        ? { code: invitation.code, expiresAt: invitation.expiresAt.toISOString() }
        : null,
    };
  });

  /** Formule et consommation du mois ; le détail par membre est réservé au chef. */
  app.get("/teams/:teamId/usage", async (request): Promise<TeamUsage> => {
    const { teamId } = parse(teamParams, request.params);
    const role = await requireMember(ctx, request.userId, teamId);
    const usage = await teamUsage(ctx, teamId);
    const names =
      role === "chef"
        ? await ctx.db
            .select({ userId: users.id, displayName: users.displayName })
            .from(teamMembers)
            .innerJoin(users, eq(users.id, teamMembers.userId))
            .where(eq(teamMembers.teamId, teamId))
        : [];
    return {
      plan: {
        id: usage.plan.id,
        name: usage.plan.name,
        maxMembers: usage.plan.maxMembers,
        maxProjects: usage.plan.maxProjects,
        monthlyCredits: usage.plan.monthlyCredits,
      },
      planEndsAt: usage.endsAt?.toISOString() ?? null,
      month: usage.month,
      used: usage.used,
      bonus: usage.bonus,
      quota: usage.quota,
      byMember:
        role === "chef"
          ? names
              .map((member) => ({
                ...member,
                credits: usage.byMember.find((row) => row.userId === member.userId)?.credits ?? 0,
              }))
              .sort((a, b) => b.credits - a.credits)
          : [],
    };
  });

  /** Le chef saisit un code promotionnel pour son équipe. */
  app.post("/teams/:teamId/promo", async (request): Promise<RedeemPromoResponse> => {
    const { teamId } = parse(teamParams, request.params);
    const { code } = parse(redeemPromoBody, request.body);
    await requireChef(ctx, request.userId, teamId);
    return { message: await redeemPromo(ctx, teamId, request.userId, code) };
  });

  app.post("/invitations/accept", async (request): Promise<{ team: Team }> => {
    const code = normalizeInvitationCode(parse(acceptInvitationBody, request.body).code);
    const [invitation] = await ctx.db
      .select({ teamId: teamInvitations.teamId })
      .from(teamInvitations)
      .where(
        and(
          eq(teamInvitations.code, code),
          isNull(teamInvitations.revokedAt),
          gt(teamInvitations.expiresAt, new Date()),
        ),
      );
    if (!invitation)
      throw new HttpError(404, "invitation_invalid", "Ce code d'invitation n'est pas valable.");
    if (await roleIn(ctx, request.userId, invitation.teamId)) {
      throw new HttpError(409, "already_member", "Vous faites déjà partie de cette équipe.");
    }
    await requireWithinPlan(ctx, invitation.teamId, "members");
    await ctx.db.insert(teamMembers).values({ teamId: invitation.teamId, userId: request.userId });
    await notifyTeam(invitation.teamId);
    return { team: await buildTeam(ctx, request.userId, invitation.teamId) };
  });

  app.delete("/teams/:teamId/members/:userId", async (request, reply) => {
    const { teamId, userId } = parse(memberParams, request.params);
    await requireChef(ctx, request.userId, teamId);
    if (userId === request.userId) throw forbidden("Le chef ne peut pas se retirer lui-même.");
    if (!(await roleIn(ctx, userId, teamId))) throw notFound("Ce membre ne fait pas partie de l'équipe.");
    await ctx.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    await notifyTeam(teamId, [userId]);
    await revokeSecretsOnDeparture(ctx, teamId, userId);
    return reply.code(204).send();
  });

  app.post("/teams/:teamId/transfer", async (request, reply) => {
    const { teamId } = parse(teamParams, request.params);
    const { userId } = parse(transferChefBody, request.body);
    await requireChef(ctx, request.userId, teamId);
    if (userId === request.userId) return reply.code(204).send();
    if (!(await roleIn(ctx, userId, teamId))) throw notFound("Ce membre ne fait pas partie de l'équipe.");
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(teamMembers)
        .set({ role: "membre" })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, request.userId)));
      await tx
        .update(teamMembers)
        .set({ role: "chef" })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    });
    await notifyTeam(teamId);
    return reply.code(204).send();
  });

  app.post("/teams/:teamId/leave", async (request, reply) => {
    const { teamId } = parse(teamParams, request.params);
    const role = await requireMember(ctx, request.userId, teamId);
    if (role === "chef") {
      throw new HttpError(
        409,
        "chef_must_transfer",
        "Transmettez d'abord votre rôle de chef à un autre membre.",
      );
    }
    await ctx.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, request.userId)));
    await notifyTeam(teamId, [request.userId]);
    await revokeSecretsOnDeparture(ctx, teamId, request.userId);
    return reply.code(204).send();
  });

  app.post("/teams/:teamId/projects", async (request): Promise<{ project: Project }> => {
    const { teamId } = parse(teamParams, request.params);
    const { name } = parse(createProjectBody, request.body);
    await requireMember(ctx, request.userId, teamId);
    await requireWithinPlan(ctx, teamId, "projects");
    const [project] = await ctx.db.insert(projects).values({ teamId, name }).returning(projectColumns);
    if (!project) throw new Error("Création du projet impossible.");
    await notifyTeam(teamId);
    return { project: toProject(project) };
  });

  app.patch("/projects/:projectId", async (request): Promise<{ project: Project }> => {
    const { projectId } = parse(projectParams, request.params);
    const changes = parse(updateProjectBody, request.body);
    const [current] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
    if (!current) throw notFound("Projet introuvable.");
    const role = await requireMember(ctx, request.userId, current.teamId);
    if (changes.archived !== undefined && role !== "chef")
      throw forbidden("Seul le chef peut archiver un projet.");

    const [project] = await ctx.db
      .update(projects)
      .set({
        ...(changes.name !== undefined && { name: changes.name }),
        ...(changes.archived !== undefined && { archivedAt: changes.archived ? new Date() : null }),
      })
      .where(eq(projects.id, projectId))
      .returning(projectColumns);
    if (!project) throw notFound("Projet introuvable.");
    await notifyTeam(current.teamId);
    return { project: toProject(project) };
  });

  /**
   * Le chef branche un dépôt GitHub au projet, ou le débranche. L'extension vérifie avant
   * envoi, avec l'accès GitHub du chef, que le dépôt existe et lit sa branche principale.
   */
  app.put("/projects/:projectId/repo", async (request): Promise<{ project: Project }> => {
    const { projectId } = parse(projectParams, request.params);
    const { repo } = parse(setProjectRepoBody, request.body);
    const [current] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
    if (!current || current.archivedAt) throw notFound("Projet introuvable.");
    await requireChef(ctx, request.userId, current.teamId);
    const [project] = await ctx.db
      .update(projects)
      .set({ repoFullName: repo?.fullName ?? null, repoDefaultBranch: repo?.defaultBranch ?? null })
      .where(eq(projects.id, projectId))
      .returning(projectColumns);
    if (!project) throw notFound("Projet introuvable.");
    await notifyTeam(current.teamId);
    if (repo?.fullName !== current.repoFullName) {
      await postAgentMessage(ctx, {
        projectId,
        teamId: current.teamId,
        kind: "serveur",
        body: repo
          ? `Le dépôt GitHub **${repo.fullName}** est branché au projet. Chaque commande du cuisinier travaillera sur sa propre branche, à partir de \`${repo.defaultBranch}\`.`
          : "Le dépôt GitHub n'est plus branché au projet : le cuisinier travaille sans branches ni commits.",
      });
    }
    return { project: toProject(project) };
  });
}
