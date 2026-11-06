import { randomUUID } from "node:crypto";
import { ATTACHMENT_MAX_BYTES } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, findSession } from "../auth/sessions.ts";
import type { AppContext } from "../context.ts";
import { attachments, orders } from "../db/schema.ts";
import { forbidden, HttpError, parse } from "../http/errors.ts";
import { CLOUD_USER_ID } from "../services/cloud.ts";

const orderParams = z.object({ orderId: z.uuid() });
const zipName = z.string().regex(/^[A-Za-z0-9._-]{1,120}$/);

/**
 * La machine cloud envoie le .zip d'une commande. Hors des routes des membres, que son jeton ne
 * peut pas appeler : seule la machine qui réalise cette commande, en ce moment, y a droit.
 */
export function cloudDeliveryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addContentTypeParser(
    "application/zip",
    { parseAs: "buffer", bodyLimit: ATTACHMENT_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post(
    "/cloud/orders/:orderId/deliverable",
    { bodyLimit: ATTACHMENT_MAX_BYTES },
    async (request): Promise<{ attachmentId: string }> => {
      const token = bearerToken(request);
      const session = token ? await findSession(ctx, token) : null;
      if (!session) throw new HttpError(401, "unauthenticated", "Connexion requise.");
      if (session.userId !== CLOUD_USER_ID) throw forbidden("Réservé à la machine cloud.");

      const { orderId } = parse(orderParams, request.params);
      const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
      if (order?.runOn !== "cloud" || order.status !== "running" || order.machineSessionId !== session.id) {
        throw forbidden("Cette machine ne réalise pas cette commande.");
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        throw new HttpError(400, "invalid_request", "Fichier vide ou absent.");
      }
      const name = parse(zipName, request.headers["x-bria-file-name"]);
      const id = randomUUID();
      const storageKey = `projects/${order.projectId}/${id}`;
      await ctx.storage.put(storageKey, request.body, "application/zip");
      await ctx.db.insert(attachments).values({
        id,
        projectId: order.projectId,
        uploaderId: null,
        name,
        contentType: "application/zip",
        size: request.body.length,
        storageKey,
      });
      return { attachmentId: id };
    },
  );
}
