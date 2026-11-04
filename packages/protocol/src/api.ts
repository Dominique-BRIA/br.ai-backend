import { z } from "zod";
import {
  ATTACHMENTS_PER_MESSAGE,
  attachment,
  locale,
  MESSAGE_MAX_LENGTH,
  machineSession,
  memoryItem,
  memoryStatus,
  memoryType,
  message,
  order,
  team,
  user,
} from "./models.ts";

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
  "file_too_large",
  "vault_disabled",
  "secret_exists",
  "email_taken",
  "plan_limit",
  "promo_invalid",
  "promo_expired",
  "promo_exhausted",
  "promo_already_used",
  "promo_not_eligible",
  "account_suspended",
  "maintenance",
  "already_invited",
  "mail_failed",
  "order_not_ready",
  "github_failed",
  "signup_limited",
  "credits_insufficient",
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

/** GET /teams/:teamId/invitations/current — la clé encore valable la plus récente, réservé au chef. */
export const currentInvitationResponse = z.object({ invitation: createInvitationResponse.nullable() });
export type CurrentInvitationResponse = z.infer<typeof currentInvitationResponse>;

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

/** PUT /projects/:projectId/repo — le chef branche un dépôt GitHub au projet, ou le débranche (null). */
export const setProjectRepoBody = z.object({
  repo: z
    .object({
      fullName: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "Format attendu : propriétaire/nom-du-dépôt"),
      defaultBranch: z.string().trim().min(1).max(200),
    })
    .nullable(),
});
export type SetProjectRepoBody = z.input<typeof setProjectRepoBody>;

/** Pull request ouverte par la machine du membre qui valide une commande. */
export const orderPullRequestBody = z.object({
  number: z.number().int().positive(),
  merged: z.boolean(),
});
export type OrderPullRequestBody = z.input<typeof orderPullRequestBody>;

/** Validation d'une commande : le serveur fusionne si l'application GitHub est connectée. */
export type OrderValidateResponse =
  | { viaServer: false }
  | { viaServer: true; number: number; url: string; merged: boolean; reason: string | null };

/** L'application GitHub, pour la proposer au chef quand il branche un dépôt. */
export interface RepoAppStatus {
  available: boolean;
  connected: boolean;
  installUrl: string | null;
}

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
export const sendMessageBody = z
  .object({
    body: z.string().trim().max(MESSAGE_MAX_LENGTH).default(""),
    replyToId: z.uuid().optional(),
    mentions: z.array(z.uuid()).max(50).default([]),
    /** Pièces jointes déjà envoyées par POST /projects/:projectId/attachments. */
    attachmentIds: z.array(z.uuid()).max(ATTACHMENTS_PER_MESSAGE).default([]),
  })
  .refine((value) => value.body.length > 0 || value.attachmentIds.length > 0, {
    message: "Un message doit contenir du texte ou une pièce jointe.",
  });
export type SendMessageBody = z.input<typeof sendMessageBody>;
export const messageResponse = z.object({ message });

// Pièces jointes

/**
 * POST /projects/:projectId/attachments — le corps est le contenu brut du fichier
 * (`Content-Type: application/octet-stream`). Le nom (encodé avec encodeURIComponent)
 * et le type du fichier passent dans les en-têtes ci-dessous.
 */
export const ATTACHMENT_NAME_HEADER = "x-file-name";
export const ATTACHMENT_TYPE_HEADER = "x-file-type";
export const attachmentResponse = z.object({ attachment });
export type AttachmentResponse = z.infer<typeof attachmentResponse>;

// Compte

/** PATCH /me */
export const updateMeBody = z.object({
  displayName: name.optional(),
  locale: locale.optional(),
});
export type UpdateMeBody = z.input<typeof updateMeBody>;

/** POST /me/email — envoie un code à la nouvelle adresse. */
export const changeEmailBody = z.object({ email });
export type ChangeEmailBody = z.input<typeof changeEmailBody>;

/** POST /me/email/verify — le code reçu confirme la nouvelle adresse. */
export const verifyEmailBody = z.object({
  email,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
export type VerifyEmailBody = z.input<typeof verifyEmailBody>;
export const meResponse = z.object({ user });

/** GET /me/sessions — les machines connectées au compte. DELETE /me/sessions/:sessionId la déconnecte. */
export const sessionsResponse = z.object({ sessions: z.array(machineSession) });
export type SessionsResponse = z.infer<typeof sessionsResponse>;

/** DELETE /me — supprime le compte. Il faut recopier son adresse e-mail. */
export const deleteAccountBody = z.object({ confirmEmail: email });
export type DeleteAccountBody = z.input<typeof deleteAccountBody>;

// Mémoire du projet

/** GET /projects/:projectId/memory */
export const memoryResponse = z.object({ items: z.array(memoryItem) });
export type MemoryResponse = z.infer<typeof memoryResponse>;

/** POST /projects/:projectId/memory — un membre ajoute lui-même une note à la mémoire. */
export const createMemoryBody = z.object({
  type: memoryType,
  text: z.string().trim().min(1).max(500),
});
export type CreateMemoryBody = z.input<typeof createMemoryBody>;

/**
 * PATCH /memory/:itemId — changer le statut d'un élément.
 * Seul le chef peut stopper une décision ; tout membre peut résoudre ou rouvrir le reste.
 */
export const updateMemoryBody = z.object({ status: memoryStatus });
export type UpdateMemoryBody = z.input<typeof updateMemoryBody>;

// Commandes du cuisinier

/** GET /projects/:projectId/orders — les commandes du projet, de la plus récente à la plus ancienne. */
export const ordersResponse = z.object({ orders: z.array(order) });
export type OrdersResponse = z.infer<typeof ordersResponse>;

/** POST /projects/:projectId/orders — un membre passe commande lui-même, sans passer par l'agent. */
export const createOrderBody = z.object({
  title: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(6000),
});
export type CreateOrderBody = z.input<typeof createOrderBody>;

/** POST /orders/:orderId/stop — réservé au demandeur et au chef. */
export const orderResponse = z.object({ order });
export type OrderResponse = z.infer<typeof orderResponse>;

// Notifications

export const notificationKind = z.enum(["mention", "reply", "order"]);
export type NotificationKind = z.infer<typeof notificationKind>;

/**
 * Ce qui concerne le membre dans ses projets : une mention, une réponse de l'IA à l'un de
 * ses messages, ou la fin d'une commande qu'il a demandée.
 */
export const notification = z.object({
  /** Identifiant stable : celui du message, ou de la commande. */
  id: z.string(),
  kind: notificationKind,
  projectId: z.uuid(),
  projectName: z.string(),
  teamName: z.string(),
  /** Message à afficher dans le chat (mention ou réponse). */
  messageId: z.uuid().nullable(),
  /** Auteur affiché : un membre, le serveur ou le cuisinier. */
  author: z.string(),
  text: z.string(),
  /** Pour une commande : son statut final. */
  orderStatus: z.enum(["done", "failed", "stopped"]).nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof notification>;

/** GET /me/notifications — les 50 plus récentes. */
export const notificationsResponse = z.object({ notifications: z.array(notification) });
export type NotificationsResponse = z.infer<typeof notificationsResponse>;

// Résumé d'absence

/** POST /projects/:projectId/catch-up — ce qui s'est passé depuis `since`. */
export const catchUpBody = z.object({ since: z.iso.datetime() });
export type CatchUpBody = z.input<typeof catchUpBody>;
export const catchUpResponse = z.object({
  /** Nombre de messages des autres depuis `since`. */
  count: z.number().int(),
  /** Résumé en Markdown ; absent s'il y a trop peu de messages ou si aucune IA n'est disponible. */
  summary: z.string().nullable(),
});
export type CatchUpResponse = z.infer<typeof catchUpResponse>;

// Mémoire locale de la machine

/** GET et PUT /me/local-memory — copie de sauvegarde de `~/.bria/memoire.md`. */
export const localMemory = z.object({
  content: z.string().max(20_000),
  updatedAt: z.iso.datetime().nullable(),
});
export type LocalMemory = z.infer<typeof localMemory>;
export const saveLocalMemoryBody = z.object({ content: z.string().max(20_000) });
export type SaveLocalMemoryBody = z.input<typeof saveLocalMemoryBody>;

// Formules et crédits

export const planSummary = z.object({
  id: z.string(),
  name: z.string(),
  maxMembers: z.number().int(),
  maxProjects: z.number().int(),
  monthlyCredits: z.number().int(),
});
export type PlanSummary = z.infer<typeof planSummary>;

/** GET /teams/:teamId/usage — formule et consommation du mois (détail par membre pour le chef). */
export const teamUsage = z.object({
  plan: planSummary,
  /** Fin de la formule ; null si elle n'expire pas. */
  planEndsAt: z.iso.datetime().nullable(),
  month: z.string(),
  used: z.number(),
  /** Crédits ajoutés ce mois-ci (code, geste de l'administrateur). */
  bonus: z.number(),
  quota: z.number(),
  byMember: z.array(z.object({ userId: z.uuid(), displayName: z.string(), credits: z.number() })),
});
export type TeamUsage = z.infer<typeof teamUsage>;

// Codes promotionnels

/** POST /teams/:teamId/promo — le chef saisit un code. */
export const redeemPromoBody = z.object({ code: z.string().trim().min(3).max(64) });
export type RedeemPromoBody = z.input<typeof redeemPromoBody>;
export const redeemPromoResponse = z.object({
  /** Ce que le code a changé, en une phrase. */
  message: z.string(),
});
export type RedeemPromoResponse = z.infer<typeof redeemPromoResponse>;

export const promoKind = z.enum(["plan", "trial", "credits", "percent", "amount"]);
export type PromoKind = z.infer<typeof promoKind>;

/** POST /admin/promo-codes — un code, ou un lot de codes uniques (count > 1). */
export const createPromoBody = z.object({
  kind: promoKind,
  /** Code choisi (public) ; absent : généré. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,40}$/)
    .optional(),
  /** Préfixe des codes générés. */
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,12}$/)
    .default("BRIA"),
  count: z.number().int().min(1).max(500).default(1),
  planId: z.string().optional(),
  durationMonths: z.number().int().min(1).max(36).optional(),
  forever: z.boolean().default(false),
  credits: z.number().int().min(1).max(10_000_000).optional(),
  trialDays: z.number().int().min(1).max(365).optional(),
  percent: z.number().int().min(1).max(100).optional(),
  amountCents: z.number().int().min(1).optional(),
  expiresAt: z.iso.datetime().optional(),
  maxUses: z.number().int().min(1).optional(),
  onePerAccount: z.boolean().default(true),
  newCustomersOnly: z.boolean().default(false),
  requiredPlanId: z.string().optional(),
  sort: z.enum(["public", "unique", "referral"]).default("public"),
  note: z.string().max(200).optional(),
});
export type CreatePromoBody = z.input<typeof createPromoBody>;

export const promoCode = z.object({
  id: z.string(),
  code: z.string(),
  kind: promoKind,
  planId: z.string().nullable(),
  durationMonths: z.number().nullable(),
  forever: z.boolean(),
  credits: z.number().nullable(),
  trialDays: z.number().nullable(),
  percent: z.number().nullable(),
  amountCents: z.number().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  maxUses: z.number().nullable(),
  usesCount: z.number(),
  sort: z.string(),
  batch: z.string().nullable(),
  note: z.string().nullable(),
  disabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PromoCode = z.infer<typeof promoCode>;

// Maintenance

/** PUT /admin/maintenance — programme une maintenance. */
export const scheduleMaintenanceBody = z.object({
  startsAt: z.iso.datetime(),
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60),
  messageFr: z.string().trim().min(1).max(500),
  messageEn: z.string().trim().min(1).max(500),
  /** Adresses des comptes qui gardent l'accès. */
  exceptions: z
    .array(z.email().transform((value) => value.toLowerCase()))
    .max(100)
    .default([]),
});
export type ScheduleMaintenanceBody = z.input<typeof scheduleMaintenanceBody>;

// Retours des testeurs

/** POST /feedback — un retour envoyé depuis l'extension. */
export const sendFeedbackBody = z.object({
  text: z.string().trim().min(1).max(5000),
  projectId: z.uuid().optional(),
  extensionVersion: z.string().max(50).optional(),
});
export type SendFeedbackBody = z.input<typeof sendFeedbackBody>;

// Coffre de secrets

/** Nom d'une variable d'environnement : lettres capitales, chiffres et soulignés. */
export const secretName = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,99}$/, "Nom en capitales, chiffres et soulignés (par exemple DATABASE_URL).");

/** Un secret, sans sa valeur : seul son nom circule. */
export const projectSecret = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Membres qui peuvent le récupérer ; le chef y a toujours accès. Vide pour un membre. */
  access: z.array(z.uuid()),
  updatedAt: z.iso.datetime(),
});
export type ProjectSecret = z.infer<typeof projectSecret>;

/** GET /projects/:projectId/secrets — tous pour le chef, ceux qui lui sont ouverts pour un membre. */
export const secretsResponse = z.object({
  /** Faux si le serveur n'a pas de clé de chiffrement : le coffre est indisponible. */
  enabled: z.boolean(),
  secrets: z.array(projectSecret),
});
export type SecretsResponse = z.infer<typeof secretsResponse>;

/** POST /projects/:projectId/secrets — réservé au chef. */
export const createSecretBody = z.object({
  name: secretName,
  value: z.string().min(1).max(10_000),
  access: z.array(z.uuid()).max(200).default([]),
});
export type CreateSecretBody = z.input<typeof createSecretBody>;

/** PATCH /secrets/:secretId — nouvelle valeur et/ou nouveaux accès, réservé au chef. */
export const updateSecretBody = z.object({
  value: z.string().min(1).max(10_000).optional(),
  access: z.array(z.uuid()).max(200).optional(),
});
export type UpdateSecretBody = z.input<typeof updateSecretBody>;

/** POST /projects/:projectId/secrets/values — les valeurs ouvertes au membre, pour écrire le .env. */
export const secretValuesResponse = z.object({
  values: z.array(z.object({ name: z.string(), value: z.string() })),
});
export type SecretValuesResponse = z.infer<typeof secretValuesResponse>;

export const secretAction = z.enum(["created", "updated", "deleted", "read"]);

/** GET /projects/:projectId/secrets/log — réservé au chef, du plus récent au plus ancien. */
export const secretLogResponse = z.object({
  entries: z.array(
    z.object({
      id: z.uuid(),
      secretName: z.string(),
      action: secretAction,
      userName: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type SecretLogResponse = z.infer<typeof secretLogResponse>;
