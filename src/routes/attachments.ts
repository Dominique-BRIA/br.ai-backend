import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_HEADER,
  ATTACHMENT_TYPE_HEADER,
  type AttachmentResponse,
  type ProjectFilesResponse,
  type ZipEntriesResponse,
} from "@br-ia/protocol";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { unzipSync } from "fflate";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { attachments, projects, users } from "../db/schema.ts";
import { HttpError, notFound, parse } from "../http/errors.ts";
import { requireProject, roleIn } from "../services/access.ts";
import { attachmentText } from "../services/attachmentText.ts";

const projectParams = z.object({ projectId: z.uuid() });
const attachmentParams = z.object({ attachmentId: z.uuid() });
const viewQuery = z.object({ view: z.literal("1").optional() });
const entryQuery = viewQuery.extend({ path: z.string().min(1).max(500) });

const ZIP_TYPE = "application/zip";
const MAX_ENTRIES = 500;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
/** Seuls ces formats s'ouvrent dans le navigateur : ni HTML ni SVG, qui pourraient y exécuter du code. */
const INLINE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);
const ENTRY_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/plain",
  csv: "text/plain",
};

function sendFile(reply: FastifyReply, body: Buffer, name: string, contentType: string, view: boolean) {
  const inline = view && INLINE_TYPES.has(contentType);
  return reply
    .header("Content-Type", contentType === "text/plain" ? "text/plain; charset=utf-8" : contentType)
    .header(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    .header("Cache-Control", "private, max-age=3600")
    .header("X-Content-Type-Options", "nosniff")
    .send(body);
}

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
      // Le texte est lu tout de suite : le message qui suit l'envoi peut demander à l'IA de l'analyser.
      await attachmentText(ctx, row);
      return { attachment: { id: row.id, name: row.name, contentType: row.contentType, size: row.size } };
    },
  );

  /** Une pièce jointe que ce membre a le droit de lire. */
  const readable = async (userId: string, attachmentId: string) => {
    const [row] = await ctx.db
      .select({ attachment: attachments, teamId: projects.teamId })
      .from(attachments)
      .innerJoin(projects, eq(projects.id, attachments.projectId))
      .where(eq(attachments.id, attachmentId));
    if (!row || !(await roleIn(ctx, userId, row.teamId))) throw notFound("Pièce jointe introuvable.");
    return row.attachment;
  };

  app.get("/attachments/:attachmentId", async (request, reply) => {
    const { attachmentId } = parse(attachmentParams, request.params);
    const { view } = parse(viewQuery, request.query);
    const file = await readable(request.userId, attachmentId);
    return sendFile(reply, await ctx.storage.get(file.storageKey), file.name, file.contentType, view === "1");
  });

  app.get("/projects/:projectId/files", async (request): Promise<ProjectFilesResponse> => {
    const { projectId } = parse(projectParams, request.params);
    await requireProject(ctx, request.userId, projectId);
    const rows = await ctx.db
      .select({ file: attachments, uploader: users.displayName })
      .from(attachments)
      .leftJoin(users, eq(users.id, attachments.uploaderId))
      .where(and(eq(attachments.projectId, projectId), isNotNull(attachments.messageId)))
      .orderBy(desc(attachments.createdAt))
      .limit(200);
    return {
      files: rows.map(({ file, uploader }) => ({
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        createdAt: file.createdAt.toISOString(),
        uploadedBy: uploader,
        hasText: file.text !== null,
      })),
    };
  });

  app.get("/attachments/:attachmentId/text", async (request, reply) => {
    const { attachmentId } = parse(attachmentParams, request.params);
    const { view } = parse(viewQuery, request.query);
    const file = await readable(request.userId, attachmentId);
    const { text, note } = await attachmentText(ctx, file);
    if (!text) throw notFound(note ?? "Aucun texte lisible dans ce document.");
    const body = note ? `> ${note}\n\n${text}` : text;
    const name = `${file.name.replace(/\.[^.]+$/, "")}.md`;
    return sendFile(reply, Buffer.from(body, "utf8"), name, "text/plain", view === "1");
  });

  app.get("/attachments/:attachmentId/files", async (request): Promise<ZipEntriesResponse> => {
    const { attachmentId } = parse(attachmentParams, request.params);
    const file = await readable(request.userId, attachmentId);
    if (file.contentType !== ZIP_TYPE) throw notFound("Ce fichier n'est pas une archive.");
    const entries: ZipEntriesResponse["entries"] = [];
    try {
      unzipSync(await ctx.storage.get(file.storageKey), {
        filter: (entry) => {
          if (!entry.name.endsWith("/") && entries.length < MAX_ENTRIES) {
            entries.push({ path: entry.name, size: entry.originalSize });
          }
          return false;
        },
      });
    } catch {
      throw new HttpError(422, "invalid_request", "Archive illisible.");
    }
    return { entries };
  });

  app.get("/attachments/:attachmentId/files/content", async (request, reply) => {
    const { attachmentId } = parse(attachmentParams, request.params);
    const { path, view } = parse(entryQuery, request.query);
    const file = await readable(request.userId, attachmentId);
    if (file.contentType !== ZIP_TYPE) throw notFound("Ce fichier n'est pas une archive.");
    let found: Record<string, Uint8Array>;
    try {
      found = unzipSync(await ctx.storage.get(file.storageKey), {
        filter: (entry) => entry.name === path && entry.originalSize <= MAX_ENTRY_BYTES,
      });
    } catch {
      throw new HttpError(422, "invalid_request", "Archive illisible.");
    }
    const content = found[path];
    if (!content) throw notFound("Fichier introuvable dans l'archive.");
    const name = path.split("/").at(-1) ?? "fichier";
    const contentType =
      ENTRY_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
    return sendFile(reply, Buffer.from(content), name, contentType, view === "1");
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
