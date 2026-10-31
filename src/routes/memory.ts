import { createMemoryBody, type MemoryItem, type MemoryResponse, updateMemoryBody } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { memoryItems, projects, users } from "../db/schema.ts";
import { forbidden, notFound, parse } from "../http/errors.ts";
import { requireProject, roleIn } from "../services/access.ts";
import {
  addMemory,
  announceMemoryChange,
  listMemory,
  setMemoryStatus,
  toMemoryItems,
} from "../services/memory.ts";
import { postAgentMessage } from "../services/messages.ts";

const projectParams = z.object({ projectId: z.uuid() });
const itemParams = z.object({ itemId: z.uuid() });

export function memoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/projects/:projectId/memory", async (request): Promise<MemoryResponse> => {
    const { projectId } = parse(projectParams, request.params);
    await requireProject(ctx, request.userId, projectId);
    return { items: await listMemory(ctx, projectId) };
  });

  /** Un membre ajoute lui-même une note (décision, question, tâche, compromis). */
  app.post("/projects/:projectId/memory", async (request): Promise<{ item: MemoryItem }> => {
    const { projectId } = parse(projectParams, request.params);
    const { type, text } = parse(createMemoryBody, request.body);
    const { project } = await requireProject(ctx, request.userId, projectId);
    const id = await addMemory(ctx, {
      projectId,
      type,
      text,
      sourceMessageId: null,
      proposedBy: { kind: "member", userId: request.userId },
    });
    await announceMemoryChange(ctx, project.teamId, projectId);
    const [row] = await ctx.db.select().from(memoryItems).where(eq(memoryItems.id, id));
    const [item] = await toMemoryItems(ctx, row ? [row] : []);
    if (!item) throw notFound("Élément introuvable.");
    return { item };
  });

  /**
   * Change le statut d'un élément. Seul le chef stoppe une décision, et le serveur
   * l'annonce dans le chat. Les autres éléments peuvent être résolus ou rouverts par tous.
   */
  app.patch("/memory/:itemId", async (request): Promise<{ item: MemoryItem }> => {
    const { itemId } = parse(itemParams, request.params);
    const { status } = parse(updateMemoryBody, request.body);
    const [row] = await ctx.db
      .select({ item: memoryItems, teamId: projects.teamId })
      .from(memoryItems)
      .innerJoin(projects, eq(projects.id, memoryItems.projectId))
      .where(eq(memoryItems.id, itemId));
    const role = row ? await roleIn(ctx, request.userId, row.teamId) : null;
    if (!row || !role) throw notFound("Élément introuvable.");
    const isDecision = row.item.type === "decision";
    if (isDecision && status !== "open" && role !== "chef") {
      throw forbidden("Seul le chef peut stopper une décision.");
    }
    if (status === "stopped" && !isDecision) throw forbidden("Seule une décision peut être stoppée.");

    await setMemoryStatus(ctx, itemId, status);
    await announceMemoryChange(ctx, row.teamId, row.item.projectId);

    if (isDecision && status === "stopped") {
      const [chef] = await ctx.db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, request.userId));
      await postAgentMessage(ctx, {
        projectId: row.item.projectId,
        teamId: row.teamId,
        kind: "serveur",
        body: `${chef?.displayName ?? "Le chef"} (chef d'équipe) a stoppé la décision : « ${row.item.text} ».`,
        ...(row.item.sourceMessageId && { replyToId: row.item.sourceMessageId }),
      });
    }

    const [updated] = await ctx.db.select().from(memoryItems).where(eq(memoryItems.id, itemId));
    const [item] = await toMemoryItems(ctx, updated ? [updated] : []);
    if (!item) throw notFound("Élément introuvable.");
    return { item };
  });
}
