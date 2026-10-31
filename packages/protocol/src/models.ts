import { z } from "zod";

/** Les objets échangés entre le serveur, l'extension et le site. */

export const locale = z.enum(["fr", "en"]);
export type Locale = z.infer<typeof locale>;

export const user = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  locale,
});
export type User = z.infer<typeof user>;

export const teamRole = z.enum(["chef", "membre"]);
export type TeamRole = z.infer<typeof teamRole>;

export const member = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  role: teamRole,
  /** Vrai si au moins une machine de ce membre est connectée. */
  online: z.boolean(),
});
export type Member = z.infer<typeof member>;

export const project = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  name: z.string(),
});
export type Project = z.infer<typeof project>;

export const team = z.object({
  id: z.uuid(),
  name: z.string(),
  myRole: teamRole,
  members: z.array(member),
  projects: z.array(project),
});
export type Team = z.infer<typeof team>;

/** Tout ce qu'un membre voit : son compte, ses équipes, leurs membres et leurs projets. */
export const workspace = z.object({
  user,
  teams: z.array(team),
});
export type Workspace = z.infer<typeof workspace>;

export const messageAuthor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: z.uuid(), displayName: z.string() }),
  /** Auteur dont le compte a été supprimé. */
  z.object({ kind: z.literal("former_member") }),
  z.object({ kind: z.literal("serveur") }),
  z.object({ kind: z.literal("cuisinier") }),
]);
export type MessageAuthor = z.infer<typeof messageAuthor>;

export const message = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  author: messageAuthor,
  /** Contenu en Markdown. */
  body: z.string(),
  /** Message auquel celui-ci répond, avec un extrait pour l'afficher sans le recharger. */
  replyTo: z
    .object({
      id: z.uuid(),
      author: messageAuthor,
      excerpt: z.string(),
    })
    .nullable(),
  /** Membres mentionnés (`@Nom`). */
  mentions: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof message>;

export const MESSAGE_MAX_LENGTH = 20_000;
