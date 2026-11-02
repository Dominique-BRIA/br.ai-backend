import { type Order, type OrdersResponse, orderPullRequestBody } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Kitchen } from "../agents/cuisinier.ts";
import type { AppContext } from "../context.ts";
import { orders, projects } from "../db/schema.ts";
import { forbidden, HttpError, notFound, parse } from "../http/errors.ts";
import { requireProject, roleIn } from "../services/access.ts";
import { postAgentMessage } from "../services/messages.ts";

const projectParams = z.object({ projectId: z.uuid() });
const orderParams = z.object({ orderId: z.uuid() });

export function orderRoutes(app: FastifyInstance, ctx: AppContext, kitchen: Kitchen | null): void {
  app.get("/projects/:projectId/orders", async (request): Promise<OrdersResponse> => {
    const { projectId } = parse(projectParams, request.params);
    await requireProject(ctx, request.userId, projectId);
    return { orders: kitchen ? await kitchen.list(projectId) : [] };
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

  /** La commande, son équipe et le rôle du membre, pour les étapes GitHub. */
  const loadForGit = async (orderId: string, userId: string) => {
    if (!kitchen) throw new HttpError(404, "not_found", "Le cuisinier n'est pas activé sur ce serveur.");
    const [row] = await ctx.db
      .select({
        order: orders,
        teamId: projects.teamId,
        repoFullName: projects.repoFullName,
        repoDefaultBranch: projects.repoDefaultBranch,
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
    const alreadyMerged = row.order.mergedAt !== null;
    const url = `https://github.com/${row.repoFullName}/pull/${body.number}`;
    const order = await row.kitchen.recordGit(orderId, row.teamId, {
      pullRequestNumber: body.number,
      pullRequestUrl: url,
      ...(body.merged && !alreadyMerged ? { mergedAt: new Date() } : {}),
    });
    if (body.merged && !alreadyMerged) {
      await postAgentMessage(ctx, {
        projectId: row.order.projectId,
        teamId: row.teamId,
        kind: "serveur",
        body: `La commande n° ${row.order.number} « ${row.order.title} » est validée et fusionnée dans \`${row.repoDefaultBranch}\` : [pull request n° ${body.number}](${url}).`,
      });
    }
    return { order };
  });
}
