import type { Order, OrdersResponse } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Kitchen } from "../agents/cuisinier.ts";
import type { AppContext } from "../context.ts";
import { orders, projects } from "../db/schema.ts";
import { forbidden, HttpError, notFound, parse } from "../http/errors.ts";
import { requireProject, roleIn } from "../services/access.ts";

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
}
