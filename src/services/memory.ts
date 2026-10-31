import type { MemoryItem, MemoryStatus, MemoryType, MessageAuthor } from "@br-ia/protocol";
import { asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { memoryItems, users } from "../db/schema.ts";
import { memberIds } from "./access.ts";

type MemoryRow = typeof memoryItems.$inferSelect;

/** La mémoire d'un projet, de la plus ancienne à la plus récente. */
export async function listMemory(ctx: AppContext, projectId: string): Promise<MemoryItem[]> {
  const rows = await ctx.db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.projectId, projectId))
    .orderBy(asc(memoryItems.createdAt));
  return toMemoryItems(ctx, rows);
}

export async function toMemoryItems(ctx: AppContext, rows: MemoryRow[]): Promise<MemoryItem[]> {
  const userIds = [...new Set(rows.flatMap((row) => (row.proposedByUserId ? [row.proposedByUserId] : [])))];
  const names = new Map(
    userIds.length === 0
      ? []
      : (
          await ctx.db
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, userIds))
        ).map((user) => [user.id, user.displayName]),
  );
  return rows.map((row) => {
    let proposedBy: MessageAuthor;
    if (row.proposedByKind !== "member") proposedBy = { kind: row.proposedByKind };
    else {
      const displayName = row.proposedByUserId ? names.get(row.proposedByUserId) : undefined;
      proposedBy =
        row.proposedByUserId && displayName
          ? { kind: "member", userId: row.proposedByUserId, displayName }
          : { kind: "former_member" };
    }
    return {
      id: row.id,
      projectId: row.projectId,
      type: row.type,
      status: row.status,
      text: row.text,
      sourceMessageId: row.sourceMessageId,
      proposedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function addMemory(
  ctx: AppContext,
  item: {
    projectId: string;
    type: MemoryType;
    text: string;
    sourceMessageId: string | null;
    proposedBy: { kind: "member"; userId: string } | { kind: "serveur" };
  },
): Promise<string> {
  const [row] = await ctx.db
    .insert(memoryItems)
    .values({
      projectId: item.projectId,
      type: item.type,
      text: item.text,
      sourceMessageId: item.sourceMessageId,
      proposedByKind: item.proposedBy.kind,
      proposedByUserId: item.proposedBy.kind === "member" ? item.proposedBy.userId : null,
    })
    .returning({ id: memoryItems.id });
  if (!row) throw new Error("Élément de mémoire non enregistré.");
  return row.id;
}

export async function setMemoryStatus(ctx: AppContext, id: string, status: MemoryStatus): Promise<void> {
  await ctx.db.update(memoryItems).set({ status, updatedAt: new Date() }).where(eq(memoryItems.id, id));
}

/** Prévient l'équipe que la mémoire du projet a changé. */
export async function announceMemoryChange(
  ctx: AppContext,
  teamId: string,
  projectId: string,
): Promise<void> {
  ctx.hub.sendTo(await memberIds(ctx, teamId), { type: "memory.changed", projectId });
}
