import type { Notification } from "@br-ia/protocol";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AppContext } from "../context.ts";
import { messages, orders, projects, teamMembers, teams, users } from "../db/schema.ts";

const LIMIT = 50;
const EXCERPT = 200;

const excerpt = (text: string) => (text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text);

/**
 * Ce qui concerne un membre dans les projets de ses équipes, du plus récent au plus ancien :
 * les messages qui le mentionnent, les réponses des agents à ses messages, et la fin des
 * commandes qu'il a demandées.
 */
export async function listNotifications(ctx: AppContext, userId: string): Promise<Notification[]> {
  // Les projets visibles : ceux, non archivés, des équipes du membre.
  const visible = ctx.db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, projects.teamId), eq(teamMembers.userId, userId)))
    .where(isNull(projects.archivedAt));
  const place = { projectName: projects.name, teamName: teams.name };

  const mentions = await ctx.db
    .select({
      id: messages.id,
      projectId: messages.projectId,
      body: messages.body,
      createdAt: messages.createdAt,
      authorName: users.displayName,
      ...place,
    })
    .from(messages)
    .innerJoin(projects, eq(projects.id, messages.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .where(
      and(
        inArray(messages.projectId, visible),
        sql`${userId}::uuid = any(${messages.mentions})`,
        or(isNull(messages.authorUserId), ne(messages.authorUserId, userId)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(LIMIT);

  const parent = alias(messages, "parent");
  const replies = await ctx.db
    .select({
      id: messages.id,
      projectId: messages.projectId,
      body: messages.body,
      createdAt: messages.createdAt,
      authorKind: messages.authorKind,
      ...place,
    })
    .from(messages)
    .innerJoin(parent, eq(parent.id, messages.replyToId))
    .innerJoin(projects, eq(projects.id, messages.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(
      and(
        inArray(messages.projectId, visible),
        eq(parent.authorUserId, userId),
        inArray(messages.authorKind, ["serveur", "cuisinier"]),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(LIMIT);

  const finished = await ctx.db
    .select({
      id: orders.id,
      projectId: orders.projectId,
      number: orders.number,
      title: orders.title,
      status: orders.status,
      sourceMessageId: orders.sourceMessageId,
      updatedAt: orders.updatedAt,
      ...place,
    })
    .from(orders)
    .innerJoin(projects, eq(projects.id, orders.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(
      and(
        inArray(orders.projectId, visible),
        eq(orders.requestedByUserId, userId),
        inArray(orders.status, ["done", "failed", "stopped"]),
      ),
    )
    .orderBy(desc(orders.updatedAt))
    .limit(LIMIT);

  const items: Notification[] = [
    ...mentions.map((row) => ({
      id: row.id,
      kind: "mention" as const,
      projectId: row.projectId,
      projectName: row.projectName,
      teamName: row.teamName,
      messageId: row.id,
      author: row.authorName ?? "",
      text: excerpt(row.body),
      orderStatus: null,
      createdAt: row.createdAt.toISOString(),
    })),
    // Une réponse qui mentionne aussi le membre n'apparaît qu'une fois, comme mention.
    ...replies
      .filter((row) => !mentions.some((mention) => mention.id === row.id))
      .map((row) => ({
        id: row.id,
        kind: "reply" as const,
        projectId: row.projectId,
        projectName: row.projectName,
        teamName: row.teamName,
        messageId: row.id,
        author: row.authorKind,
        text: excerpt(row.body),
        orderStatus: null,
        createdAt: row.createdAt.toISOString(),
      })),
    ...finished.map((row) => ({
      id: row.id,
      kind: "order" as const,
      projectId: row.projectId,
      projectName: row.projectName,
      teamName: row.teamName,
      messageId: row.sourceMessageId,
      author: "cuisinier",
      text: `${row.number} · ${row.title}`,
      orderStatus: row.status as "done" | "failed" | "stopped",
      createdAt: row.updatedAt.toISOString(),
    })),
  ];
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, LIMIT);
}
