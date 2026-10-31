import { type ListMessagesResponse, listMessagesQuery, type Message, sendMessageBody } from "@br-ia/protocol";
import { and, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { attachments, messages, teamMembers } from "../db/schema.ts";
import { notFound, parse } from "../http/errors.ts";
import { memberIds, requireProject } from "../services/access.ts";
import { loadMessage, toMessages } from "../services/messages.ts";

const projectParams = z.object({ projectId: z.uuid() });

export function messageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/projects/:projectId/messages", async (request): Promise<ListMessagesResponse> => {
    const { projectId } = parse(projectParams, request.params);
    const { before, limit } = parse(listMessagesQuery, request.query);
    await requireProject(ctx, request.userId, projectId);

    let cursor: SQL | undefined;
    if (before) {
      const [anchor] = await ctx.db
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.id, before), eq(messages.projectId, projectId)));
      if (!anchor) throw notFound("Message introuvable.");
      // Les messages plus anciens que le repère, à date égale départagés par l'identifiant.
      cursor = or(
        lt(messages.createdAt, anchor.createdAt),
        and(eq(messages.createdAt, anchor.createdAt), lt(messages.id, anchor.id)),
      );
    }

    const rows = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.projectId, projectId), cursor))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return { messages: await toMessages(ctx, page), hasMore };
  });

  app.post("/projects/:projectId/messages", async (request): Promise<{ message: Message }> => {
    const { projectId } = parse(projectParams, request.params);
    const { body, replyToId, mentions, attachmentIds } = parse(sendMessageBody, request.body);
    const { project } = await requireProject(ctx, request.userId, projectId);

    if (replyToId) {
      const [parent] = await ctx.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, replyToId), eq(messages.projectId, projectId)));
      if (!parent) throw notFound("Le message auquel vous répondez est introuvable.");
    }

    // On ne garde que les mentions de membres de l'équipe.
    const uniqueMentions = [...new Set(mentions)];
    const validMentions =
      uniqueMentions.length === 0
        ? []
        : (
            await ctx.db
              .select({ userId: teamMembers.userId })
              .from(teamMembers)
              .where(and(eq(teamMembers.teamId, project.teamId), inArray(teamMembers.userId, uniqueMentions)))
          ).map((row) => row.userId);

    // Pièces jointes : envoyées par ce membre dans ce projet, et pas encore jointes à un message.
    const fileIds = [...new Set(attachmentIds)];
    if (fileIds.length > 0) {
      const usable = await ctx.db
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          and(
            inArray(attachments.id, fileIds),
            eq(attachments.projectId, projectId),
            eq(attachments.uploaderId, request.userId),
            isNull(attachments.messageId),
          ),
        );
      if (usable.length !== fileIds.length) throw notFound("Pièce jointe introuvable ou déjà envoyée.");
    }

    const row = await ctx.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messages)
        .values({
          projectId,
          authorKind: "member",
          authorUserId: request.userId,
          body,
          replyToId,
          mentions: validMentions,
        })
        .returning({ id: messages.id });
      if (inserted && fileIds.length > 0) {
        await tx.update(attachments).set({ messageId: inserted.id }).where(inArray(attachments.id, fileIds));
      }
      return inserted;
    });
    const message = row && (await loadMessage(ctx, row.id));
    if (!message) throw new Error("Message non enregistré.");

    ctx.hub.sendTo(await memberIds(ctx, project.teamId), { type: "message.created", message });
    return { message };
  });
}
