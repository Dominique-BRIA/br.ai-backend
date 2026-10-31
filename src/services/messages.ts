import type { Message, MessageAuthor } from "@br-ia/protocol";
import { eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { messages, users } from "../db/schema.ts";

type MessageRow = typeof messages.$inferSelect;

const EXCERPT_LENGTH = 140;

/** Transforme des lignes de la table `messages` en messages du protocole (auteurs, réponses). */
export async function toMessages(ctx: AppContext, rows: MessageRow[]): Promise<Message[]> {
  const parentIds = [...new Set(rows.flatMap((row) => (row.replyToId ? [row.replyToId] : [])))];
  const parents =
    parentIds.length === 0 ? [] : await ctx.db.select().from(messages).where(inArray(messages.id, parentIds));

  const authorIds = [
    ...new Set([...rows, ...parents].flatMap((row) => (row.authorUserId ? [row.authorUserId] : []))),
  ];
  const names = new Map(
    authorIds.length === 0
      ? []
      : (
          await ctx.db
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, authorIds))
        ).map((user) => [user.id, user.displayName]),
  );

  const author = (row: MessageRow): MessageAuthor => {
    if (row.authorKind !== "member") return { kind: row.authorKind };
    const displayName = row.authorUserId ? names.get(row.authorUserId) : undefined;
    return row.authorUserId && displayName
      ? { kind: "member", userId: row.authorUserId, displayName }
      : { kind: "former_member" };
  };
  const parentsById = new Map(parents.map((parent) => [parent.id, parent]));

  return rows.map((row) => {
    const parent = row.replyToId ? parentsById.get(row.replyToId) : undefined;
    return {
      id: row.id,
      projectId: row.projectId,
      author: author(row),
      body: row.body,
      replyTo: parent ? { id: parent.id, author: author(parent), excerpt: excerpt(parent.body) } : null,
      mentions: row.mentions,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function loadMessage(ctx: AppContext, id: string): Promise<Message | null> {
  const rows = await ctx.db.select().from(messages).where(eq(messages.id, id));
  const [message] = await toMessages(ctx, rows);
  return message ?? null;
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat;
}
