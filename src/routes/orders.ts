import {
  createOrderBody,
  type Order,
  type OrdersResponse,
  type OrderValidateResponse,
  orderPullRequestBody,
} from "@br-ia/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Kitchen } from "../agents/cuisinier.ts";
import type { AppContext } from "../context.ts";
import { orders, projects, users } from "../db/schema.ts";
import { forbidden, HttpError, notFound, parse } from "../http/errors.ts";
import { memberIds, requireProject, roleIn } from "../services/access.ts";
import { quotaReached } from "../services/credits.ts";
import type { GitHubApp, ServerMerge } from "../services/githubApp.ts";
import { postAgentMessage } from "../services/messages.ts";

const projectParams = z.object({ projectId: z.uuid() });
const orderParams = z.object({ orderId: z.uuid() });

export function orderRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  kitchen: Kitchen | null,
  github: GitHubApp | null,
): void {
  app.get("/projects/:projectId/orders", async (request): Promise<OrdersResponse> => {
    const { projectId } = parse(projectParams, request.params);
    await requireProject(ctx, request.userId, projectId);
    return { orders: kitchen ? await kitchen.list(projectId) : [] };
  });

  /**
   * Un membre passe commande lui-même, avec un titre et ce qu'il attend. Le serveur l'annonce dans
   * le chat, puis la commande attend une machine comme celles passées par l'agent.
   */
  app.post("/projects/:projectId/orders", async (request): Promise<{ order: Order }> => {
    const { projectId } = parse(projectParams, request.params);
    const { title, brief } = parse(createOrderBody, request.body);
    const { project } = await requireProject(ctx, request.userId, projectId);
    if (!kitchen) throw new HttpError(404, "not_found", "Le cuisinier n'est pas activé sur ce serveur.");
    if (await quotaReached(ctx, project.teamId)) {
      throw new HttpError(
        402,
        "credits_insufficient",
        "Crédit insuffisant : le chef peut saisir un code d'invitation dans la page de l'équipe.",
      );
    }
    const [author] = await ctx.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, request.userId));
    // Le titre est écrit par le membre : il reste du texte, même s'il contient du Markdown.
    const plainTitle = title.replace(/[\\`*_[\]<>#|]/g, "");
    const announcement = await postAgentMessage(ctx, {
      projectId,
      teamId: project.teamId,
      kind: "serveur",
      body: `${author?.displayName ?? "Un membre"} a passé une commande au cuisinier : **${plainTitle}**.`,
    });
    const order = await kitchen.createOrder({
      projectId,
      teamId: project.teamId,
      title,
      brief,
      requestedByUserId: request.userId,
      sourceMessageId: announcement.id,
      memoryItemId: null,
    });
    return { order };
  });

  /** Arrête une commande : réservé au demandeur et au chef (F-CMD-04). */
  app.post("/orders/:orderId/stop", async (request): Promise<{ order: Order }> => {
    const { orderId } = parse(orderParams, request.params);
    if (!kitchen) throw new HttpError(404, "not_found", "Le cuisinier n'est pas activé sur ce serveur.");
    const [row] = await ctx.db
      .select({ order: orders, teamId: projects.teamId })
      .from(orders)
      .innerJoin(projects, eq(projects.id, orders.projectId))
      .where(eq(orders.id, orderId));
    const role = row ? await roleIn(ctx, request.userId, row.teamId) : null;
    if (!row || !role) throw notFound("Commande introuvable.");
    if (role !== "chef" && row.order.requestedByUserId !== request.userId) {
      throw forbidden("Seuls le demandeur et le chef peuvent arrêter une commande.");
    }
    await kitchen.stop(orderId);
    const order = (await kitchen.list(row.order.projectId)).find((candidate) => candidate.id === orderId);
    if (!order) throw notFound("Commande introuvable.");
    return { order };
  });

  /** Passe une commande en cours à une autre machine : demandeur, chef ou propriétaire de la machine (F-REL-01). */
  app.post("/orders/:orderId/relay", async (request): Promise<{ order: Order }> => {
    const { orderId } = parse(orderParams, request.params);
    if (!kitchen) throw new HttpError(404, "not_found", "Le cuisinier n'est pas activé sur ce serveur.");
    const [row] = await ctx.db
      .select({ order: orders, teamId: projects.teamId })
      .from(orders)
      .innerJoin(projects, eq(projects.id, orders.projectId))
      .where(eq(orders.id, orderId));
    const role = row ? await roleIn(ctx, request.userId, row.teamId) : null;
    if (!row || !role) throw notFound("Commande introuvable.");
    const allowed =
      role === "chef" ||
      row.order.requestedByUserId === request.userId ||
      row.order.machineUserId === request.userId;
    if (!allowed)
      throw forbidden(
        "Seuls le demandeur, le chef et le propriétaire de la machine peuvent passer le relais.",
      );
    if (!(await kitchen.relay(orderId, row.teamId))) {
      throw new HttpError(
        409,
        "order_not_ready",
        "Le relais demande une commande en cours sur un projet branché à un dépôt GitHub.",
      );
    }
    const order = (await kitchen.list(row.order.projectId)).find((item) => item.id === orderId);
    if (!order) throw notFound("Commande introuvable.");
    return { order };
  });

  /** La commande, son équipe et le rôle du membre, pour les étapes GitHub. */
  const loadForGit = async (orderId: string, userId: string) => {
    if (!kitchen) throw new HttpError(404, "not_found", "Le cuisinier n'est pas activé sur ce serveur.");
    const [row] = await ctx.db
      .select({
        order: orders,
        teamId: projects.teamId,
        repoFullName: projects.repoFullName,
        repoDefaultBranch: projects.repoDefaultBranch,
        repoInstallationId: projects.repoInstallationId,
      })
      .from(orders)
      .innerJoin(projects, eq(projects.id, orders.projectId))
      .where(eq(orders.id, orderId));
    const role = row ? await roleIn(ctx, userId, row.teamId) : null;
    if (!row || !role) throw notFound("Commande introuvable.");
    if (row.order.status !== "done" || !row.order.branch || !row.order.commitSha) {
      throw new HttpError(409, "order_not_ready", "Cette commande n'a pas de travail enregistré dans Git.");
    }
    return { ...row, role, kitchen };
  };

  /** La machine qui a fait le commit l'a poussé plus tard : seul son propriétaire peut le dire. */
  app.post("/orders/:orderId/pushed", async (request): Promise<{ order: Order }> => {
    const { orderId } = parse(orderParams, request.params);
    const row = await loadForGit(orderId, request.userId);
    if (row.order.machineUserId !== request.userId) {
      throw forbidden("Seul le propriétaire de la machine peut pousser cette branche.");
    }
    return { order: await row.kitchen.recordGit(orderId, row.teamId, { pushedAt: new Date() }) };
  });

  /**
   * Le demandeur (ou le chef, s'il n'est plus là) valide la commande : sa machine ouvre la pull
   * request et la fusionne avec son accès GitHub, puis le serveur l'enregistre (F-GIT-05).
   */
  app.put("/orders/:orderId/pull-request", async (request): Promise<{ order: Order }> => {
    const { orderId } = parse(orderParams, request.params);
    const body = parse(orderPullRequestBody, request.body);
    const row = await loadForGit(orderId, request.userId);
    if (row.role !== "chef" && row.order.requestedByUserId !== request.userId) {
      throw forbidden("Seuls le demandeur et le chef peuvent valider une commande.");
    }
    if (!row.repoFullName) {
      throw new HttpError(409, "order_not_ready", "Ce projet n'a plus de dépôt GitHub.");
    }
    return {
      order: await recordOrderPullRequest(ctx, row.kitchen, {
        order: row.order,
        teamId: row.teamId,
        repoFullName: row.repoFullName,
        repoDefaultBranch: row.repoDefaultBranch,
        number: body.number,
        merged: body.merged,
        byUserId: request.userId,
      }),
    };
  });

  /**
   * Le demandeur valide. Si l'application GitHub est connectée, le serveur fusionne lui-même ;
   * sinon la réponse demande à la machine du membre de le faire avec son accès.
   */
  app.post("/orders/:orderId/validate", async (request): Promise<OrderValidateResponse> => {
    const { orderId } = parse(orderParams, request.params);
    const row = await loadForGit(orderId, request.userId);
    if (row.role !== "chef" && row.order.requestedByUserId !== request.userId) {
      throw forbidden("Seuls le demandeur et le chef peuvent valider une commande.");
    }
    if (!github || !row.repoInstallationId) return { viaServer: false };
    if (!row.repoFullName || !row.repoDefaultBranch || !row.order.branch || !row.order.pushedAt) {
      throw new HttpError(409, "order_not_ready", "La branche de cette commande n'est pas sur GitHub.");
    }
    let outcome: ServerMerge;
    try {
      outcome = await github.mergeBranch(row.repoInstallationId, row.repoFullName, {
        branch: row.order.branch,
        base: row.repoDefaultBranch,
        title: row.order.title,
        body: `Commande n° ${row.order.number}.\n\n${row.order.summary ?? ""}`.trim(),
      });
    } catch (error) {
      throw new HttpError(502, "github_failed", (error as Error).message);
    }
    await recordOrderPullRequest(ctx, row.kitchen, {
      order: row.order,
      teamId: row.teamId,
      repoFullName: row.repoFullName,
      repoDefaultBranch: row.repoDefaultBranch,
      number: outcome.number,
      merged: outcome.merged,
      byUserId: request.userId,
    });
    return { viaServer: true, ...outcome };
  });
}

/**
 * Enregistre la pull request d'une commande et, à la première fusion, l'annonce : les membres
 * absents la retrouvent dans leurs notifications (F-GIT-06). Une fusion déjà connue ne change rien.
 */
export async function recordOrderPullRequest(
  ctx: AppContext,
  kitchen: Kitchen,
  input: {
    order: typeof orders.$inferSelect;
    teamId: string;
    repoFullName: string;
    repoDefaultBranch: string | null;
    number: number;
    merged: boolean;
    /** Le membre qui valide n'a pas besoin d'être prévenu. */
    byUserId?: string;
  },
): Promise<Order> {
  const { order: row, teamId, number, merged } = input;
  // GitHub peut prévenir pendant que la validation se termine : le premier arrivé annonce, seul.
  const first =
    row.mergedAt === null &&
    (!merged ||
      (
        await ctx.db
          .update(orders)
          .set({ mergedAt: new Date() })
          .where(and(eq(orders.id, row.id), isNull(orders.mergedAt)))
          .returning({ id: orders.id })
      ).length > 0);
  if (!first) {
    const order = (await kitchen.list(row.projectId)).find((item) => item.id === row.id);
    if (!order) throw notFound("Commande introuvable.");
    return order;
  }
  const url = `https://github.com/${input.repoFullName}/pull/${number}`;
  const order = await kitchen.recordGit(row.id, teamId, {
    pullRequestNumber: number,
    pullRequestUrl: url,
  });
  if (merged) {
    await postAgentMessage(ctx, {
      projectId: row.projectId,
      teamId,
      kind: "serveur",
      body: `La commande n° ${row.number} « ${row.title} » est validée et fusionnée dans \`${input.repoDefaultBranch}\` : [pull request n° ${number}](${url}). Une nouvelle version est disponible.`,
      mentions: (await memberIds(ctx, teamId)).filter((id) => id !== input.byUserId),
    });
  }
  return order;
}
