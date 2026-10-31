import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_HEADER,
  ATTACHMENT_TYPE_HEADER,
  type AttachmentResponse,
} from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { attachments, projects } from "../db/schema.ts";
import { HttpError, notFound, parse } from "../http/errors.ts";
import { requireProject, roleIn } from "../services/access.ts";

const projectParams = z.object({ projectId: z.uuid() });
const attachmentParams = z.object({ attachmentId: z.uuid() });

export function attachmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Le corps d'un envoi est le fichier brut.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: ATTACHMENT_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post(
    "/projects/:projectId/attachments",
    {
      bodyLimit: ATTACHMENT_MAX_BYTES,
      errorHandler: (error, _request, reply) => {
        if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.code(413).send({
            error: { code: "file_too_large", message: "Fichier trop volumineux (20 Mo au plus)." },
          });
        }
        throw error;
      },
    },
    async (request): Promise<AttachmentResponse> => {
      const { projectId } = parse(projectParams, request.params);
      await requireProject(ctx, request.userId, projectId);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        throw new HttpError(400, "invalid_request", "Fichier vide ou absent.");
      }

      const name = fileName(request.headers[ATTACHMENT_NAME_HEADER]);
      const contentType = fileType(request.headers[ATTACHMENT_TYPE_HEADER]);
      const id = randomUUID();
      const storageKey = `projects/${projectId}/${id}`;
      await ctx.storage.put(storageKey, request.body, contentType);
      const [row] = await ctx.db
        .insert(attachments)
        .values({
          id,
          projectId,
          uploaderId: request.userId,
          name,
          contentType,
          size: request.body.length,
          storageKey,
        })
        .returning();
      if (!row) throw new Error("Pièce jointe non enregistrée.");
      return { attachment: { id: row.id, name: row.name, contentType: row.contentType, size: row.size } };
    },
  );

  app.get("/attachments/:attachmentId", async (request, reply) => {
    const { attachmentId } = parse(attachmentParams, request.params);
    const [row] = await ctx.db
      .select({ attachment: attachments, teamId: projects.teamId })
      .from(attachments)
      .innerJoin(projects, eq(projects.id, attachments.projectId))
      .where(eq(attachments.id, attachmentId));
    if (!row || !(await roleIn(ctx, request.userId, row.teamId))) throw notFound("Pièce jointe introuvable.");

    const body = await ctx.storage.get(row.attachment.storageKey);
    return reply
      .header("Content-Type", row.attachment.contentType)
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(row.attachment.name)}`,
      )
      .header("Cache-Control", "private, max-age=3600")
      .header("X-Content-Type-Options", "nosniff")
      .send(body);
  });
}

function fileName(raw: string | string[] | undefined): string {
  let name = "fichier";
  if (typeof raw === "string") {
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
  }
  // Pas de chemin, pas de caractères de contrôle, longueur raisonnable.
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = Array.from(base)
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 200);
  return cleaned || "fichier";
}

function fileType(raw: string | string[] | undefined): string {
  return typeof raw === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(raw) ? raw : "application/octet-stream";
}
