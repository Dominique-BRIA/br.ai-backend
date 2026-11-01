import type { Attachment, Message, MessageAuthor } from "@br-ia/protocol";
import { asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { attachments, messages, users } from "../db/schema.ts";
import { memberIds } from "./access.ts";

type MessageRow = typeof messages.$inferSelect;

const EXCERPT_LENGTH = 140;

/** Transforme des lignes de la table `messages` en messages du protocole (auteurs, réponses, pièces jointes). */
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

  const files = new Map<string, Attachment[]>();
  if (rows.length > 0) {
    const attached = await ctx.db
      .select()
      .from(attachments)
      .where(
        inArray(
          attachments.messageId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(attachments.createdAt));
    for (const file of attached) {
      if (!file.messageId) continue;
      const list = files.get(file.messageId) ?? [];
      list.push({ id: file.id, name: file.name, contentType: file.contentType, size: file.size });
      files.set(file.messageId, list);
    }
  }

  return rows.map((row) => {
    const parent = row.replyToId ? parentsById.get(row.replyToId) : undefined;
    return {
      id: row.id,
      projectId: row.projectId,
      author: author(row),
      body: row.body,
      replyTo: parent ? { id: parent.id, author: author(parent), excerpt: excerpt(parent.body) } : null,
      mentions: row.mentions,
      attachments: files.get(row.id) ?? [],
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

/** Publie un message d'un agent (serveur ou cuisinier) dans un projet et le diffuse à l'équipe. */
export async function postAgentMessage(
  ctx: AppContext,
  options: {
    projectId: string;
    teamId: string;
    kind: "serveur" | "cuisinier";
    body: string;
    replyToId?: string;
    /** Membres à prévenir : le message apparaît dans leurs notifications. */
    mentions?: string[];
  },
): Promise<Message> {
  const [row] = await ctx.db
    .insert(messages)
    .values({
      projectId: options.projectId,
      authorKind: options.kind,
      body: options.body,
      replyToId: options.replyToId,
      mentions: options.mentions ?? [],
    })
    .returning({ id: messages.id });
  const message = row && (await loadMessage(ctx, row.id));
  if (!message) throw new Error("Message de l'agent non enregistré.");
  ctx.hub.sendTo(await memberIds(ctx, options.teamId), { type: "message.created", message });
  return message;
}
