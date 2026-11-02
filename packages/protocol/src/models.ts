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
  /** Dernière activité connue d'une de ses machines. */
  lastSeenAt: z.iso.datetime().nullable(),
});
export type Member = z.infer<typeof member>;

/** Dépôt GitHub branché au projet : « propriétaire/nom » et sa branche principale. */
export const projectRepo = z.object({
  fullName: z.string(),
  defaultBranch: z.string(),
});
export type ProjectRepo = z.infer<typeof projectRepo>;

export const project = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  name: z.string(),
  repo: projectRepo.nullable(),
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
/** État de la plateforme : aucune maintenance, une maintenance annoncée, ou en cours. */
export const maintenanceStatus = z.object({
  state: z.enum(["none", "scheduled", "ongoing"]),
  startsAt: z.iso.datetime().nullable(),
  /** Fin estimée, d'après la durée annoncée. */
  endsAt: z.iso.datetime().nullable(),
  message: z.object({ fr: z.string(), en: z.string() }),
  /** Vrai si le compte qui demande garde l'accès pendant la maintenance. */
  exempt: z.boolean(),
});
export type MaintenanceStatus = z.infer<typeof maintenanceStatus>;

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

/** Commande passée au cuisinier. */
export const orderStatus = z.enum([
  /** En attente d'une machine disponible, ou de son tour (une commande active par projet). */
  "pending",
  "running",
  "done",
  "failed",
  /** Arrêtée par le demandeur ou par le chef. */
  "stopped",
]);
export type OrderStatus = z.infer<typeof orderStatus>;

export const orderStep = z.object({
  at: z.iso.datetime(),
  kind: z.enum(["info", "read", "write", "command", "error"]),
  text: z.string(),
});
export type OrderStep = z.infer<typeof orderStep>;

export const order = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  /** Numéro lisible dans le projet : commande n° 3. */
  number: z.number().int().positive(),
  title: z.string(),
  /** Ce que le cuisinier doit faire, reformulé par le serveur. */
  brief: z.string(),
  status: orderStatus,
  requestedBy: messageAuthor,
  /** Machine sur laquelle le cuisinier travaille ou a travaillé. */
  machine: z.object({ userId: z.uuid(), displayName: z.string(), sessionId: z.uuid() }).nullable(),
  /** Bilan du cuisinier à la fin de la commande. */
  summary: z.string().nullable(),
  /** Fichiers modifiés, relatifs au dossier du projet. */
  changedFiles: z.array(z.string()),
  /** Branche Git de la commande (bria/<numéro>-<titre>), quand le projet a un dépôt. */
  branch: z.string().nullable(),
  /** Dernier commit du cuisinier sur cette branche. */
  commit: z.string().nullable(),
  /** La branche a été poussée sur GitHub. */
  pushed: z.boolean(),
  /** Dernières étapes, de la plus ancienne à la plus récente. */
  steps: z.array(orderStep),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Order = z.infer<typeof order>;
