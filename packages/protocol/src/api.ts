import { z } from "zod";
import { MESSAGE_MAX_LENGTH, message, team, user } from "./models.ts";

/**
 * L'API HTTP du serveur. Chaque route a son schéma de requête et de réponse.
 * Toutes les routes, sauf celles de `/auth/code` et `/auth/verify`, exigent
 * l'en-tête `Authorization: Bearer <jeton de session>`.
 */

/** Codes d'erreur renvoyés dans `{ error: { code, message } }`. */
export const apiErrorCode = z.enum([
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "invitation_required",
  "invitation_invalid",
  "code_invalid",
  "code_expired",
  "too_many_attempts",
  "too_many_requests",
  "display_name_required",
  "chef_must_transfer",
  "already_member",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCode>;

export const apiError = z.object({
  error: z.object({ code: apiErrorCode, message: z.string() }),
});
export type ApiError = z.infer<typeof apiError>;

const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
const invitationCode = z.string().trim().min(4).max(64);
const name = z.string().trim().min(1).max(80);

// Connexion

/** POST /auth/code — envoie un code de connexion par e-mail. */
export const requestCodeBody = z.object({
  email,
  /** Obligatoire pour créer un compte pendant la bêta : code d'invitation à la bêta ou à une équipe. */
  invitationCode: invitationCode.optional(),
});
export type RequestCodeBody = z.input<typeof requestCodeBody>;
export const requestCodeResponse = z.object({
  /** Vrai si aucun compte n'existe encore pour cette adresse : il faudra un nom affiché. */
  newAccount: z.boolean(),
});
export type RequestCodeResponse = z.infer<typeof requestCodeResponse>;

/** POST /auth/verify — vérifie le code et ouvre une session pour cette machine. */
export const verifyCodeBody = z.object({
  email,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  machineId: z.string().min(1).max(100),
  /** Obligatoire pour un nouveau compte. */
  displayName: name.optional(),
});
export type VerifyCodeBody = z.input<typeof verifyCodeBody>;
export const verifyCodeResponse = z.object({
  token: z.string(),
  user,
});
export type VerifyCodeResponse = z.infer<typeof verifyCodeResponse>;

// Équipes et projets

/** POST /teams */
export const createTeamBody = z.object({ name });
export type CreateTeamBody = z.input<typeof createTeamBody>;
export const teamResponse = z.object({ team });

/** POST /teams/:teamId/invitations — réservé au chef. */
export const createInvitationResponse = z.object({
  code: z.string(),
  expiresAt: z.iso.datetime(),
});
export type CreateInvitationResponse = z.infer<typeof createInvitationResponse>;

/** POST /invitations/accept */
export const acceptInvitationBody = z.object({ code: invitationCode });
export type AcceptInvitationBody = z.input<typeof acceptInvitationBody>;

/** POST /teams/:teamId/transfer — le chef transmet son rôle. */
export const transferChefBody = z.object({ userId: z.uuid() });
export type TransferChefBody = z.input<typeof transferChefBody>;

/** POST /teams/:teamId/projects */
export const createProjectBody = z.object({ name });
export type CreateProjectBody = z.input<typeof createProjectBody>;

/** PATCH /projects/:projectId — renommer (tout membre) ou archiver (chef). */
export const updateProjectBody = z.object({
  name: name.optional(),
  archived: z.boolean().optional(),
});
export type UpdateProjectBody = z.input<typeof updateProjectBody>;

// Messages

export const MESSAGES_PAGE_SIZE = 50;

/** GET /projects/:projectId/messages?before=<messageId> */
export const listMessagesQuery = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(MESSAGES_PAGE_SIZE),
});
export const listMessagesResponse = z.object({
  /** Du plus ancien au plus récent. */
  messages: z.array(message),
  hasMore: z.boolean(),
});
export type ListMessagesResponse = z.infer<typeof listMessagesResponse>;

/** POST /projects/:projectId/messages */
export const sendMessageBody = z.object({
  body: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
  replyToId: z.uuid().optional(),
  mentions: z.array(z.uuid()).max(50).default([]),
});
export type SendMessageBody = z.input<typeof sendMessageBody>;
export const messageResponse = z.object({ message });
