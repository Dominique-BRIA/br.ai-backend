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

/** Fichier joint à un message. Son contenu se télécharge par GET /attachments/:id. */
export const attachment = z.object({
  id: z.uuid(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof attachment>;

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 10;

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
  attachments: z.array(attachment),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof message>;

export const MESSAGE_MAX_LENGTH = 20_000;

/** Une machine connectée au compte (une session). */
export const machineSession = z.object({
  id: z.uuid(),
  os: z.string().nullable(),
  editor: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** La session de la machine qui fait la demande. */
  current: z.boolean(),
  /** Vrai si cette machine est connectée en ce moment. */
  online: z.boolean(),
});
export type MachineSession = z.infer<typeof machineSession>;

/** Mémoire du projet, tenue par l'agent serveur (et modifiable par les membres). */
export const memoryType = z.enum(["decision", "question", "task", "compromise"]);
export type MemoryType = z.infer<typeof memoryType>;

/** Ouvert ; résolu (question tranchée, tâche faite, compromis accepté) ; stoppé par le chef. */
export const memoryStatus = z.enum(["open", "resolved", "stopped"]);
export type MemoryStatus = z.infer<typeof memoryStatus>;

export const memoryItem = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  type: memoryType,
  status: memoryStatus,
  text: z.string(),
  /** Message à l'origine de cet élément. */
  sourceMessageId: z.uuid().nullable(),
  /** Membre qui l'a proposé (pour une décision : l'auteur du message d'origine). */
  proposedBy: messageAuthor,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MemoryItem = z.infer<typeof memoryItem>;
