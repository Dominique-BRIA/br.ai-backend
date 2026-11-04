import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const locale = pgEnum("locale", ["fr", "en"]);
export const teamRole = pgEnum("team_role", ["chef", "membre"]);
export const authorKind = pgEnum("author_kind", ["member", "serveur", "cuisinier"]);
export const invitationKind = pgEnum("invitation_kind", ["beta", "team"]);
export const memoryType = pgEnum("memory_type", ["decision", "question", "task", "compromise"]);
export const memoryStatus = pgEnum("memory_status", ["open", "resolved", "stopped"]);
export const orderStatus = pgEnum("order_status", ["pending", "running", "done", "failed", "stopped"]);

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  displayName: text().notNull(),
  locale: locale().notNull().default("fr"),
  /** Compte suspendu par un administrateur : ses sessions sont refusées. */
  suspendedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Une session par machine connectée, révocable à distance. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Empreinte du jeton de session : le jeton lui-même n'est jamais stocké. */
    tokenHash: text().notNull().unique(),
    machineId: text().notNull(),
    /** Système et éditeur de la machine, mis à jour à chaque connexion temps réel. */
    os: text(),
    editor: text(),
    createdAt: createdAt(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId)],
);

/** Codes d'invitation à la bêta, créés par l'équipe interne. */
export const betaInvites = pgTable("beta_invites", {
  id: uuid().primaryKey().defaultRandom(),
  code: text().notNull().unique(),
  note: text(),
  maxUses: integer().notNull().default(1),
  uses: integer().notNull().default(0),
  expiresAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Demandes d'accès à la bêta, laissées sur la page d'accueil du site. */
export const betaRequests = pgTable("beta_requests", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  /** Code d'invitation envoyé en réponse, une fois la demande acceptée. */
  inviteCode: text(),
  invitedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Codes de connexion envoyés par e-mail. */
export const loginCodes = pgTable(
  "login_codes",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    attempts: integer().notNull().default(0),
    /** Invitation présentée pour créer le compte, à consommer à la vérification. */
    invitationKind: invitationKind(),
    invitationId: uuid(),
    /** « login » pour se connecter ; « email_change » pour confirmer la nouvelle adresse d'un compte. */
    purpose: text().$type<"login" | "email_change">().notNull().default("login"),
    /** Pour un changement d'adresse : le compte concerné. */
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.email, t.createdAt)],
);

export const teams = pgTable("teams", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  /** Formule de l'équipe ; à sa date de fin, l'équipe revient à l'essai. */
  planId: text()
    .notNull()
    .default("essai")
    .references((): AnyPgColumn => plans.id),
  planEndsAt: timestamp({ withTimezone: true }),
  /** Mois (« 2026-11 ») où le chef a été prévenu à 80 % puis à 100 % du quota, pour ne le dire qu'une fois. */
  quotaWarnedMonth: text(),
  quotaExceededMonth: text(),
  createdAt: createdAt(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: teamRole().notNull().default("membre"),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index().on(t.userId),
    // Un seul chef par équipe.
    uniqueIndex("team_members_one_chef").on(t.teamId).where(sql`${t.role} = 'chef'`),
  ],
);

/** Invitations à rejoindre une équipe : un code partageable, valable jusqu'à son expiration. */
export const teamInvitations = pgTable("team_invitations", {
  id: uuid().primaryKey().defaultRandom(),
  teamId: uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  code: text().notNull().unique(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  revokedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

export const projects = pgTable(
  "projects",
  {
    id: uuid().primaryKey().defaultRandom(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Dépôt GitHub branché par le chef : « propriétaire/nom ». */
    repoFullName: text(),
    repoDefaultBranch: text(),
    /** Installation de l'application GitHub, confirmée par un compte qui peut écrire dans le dépôt. */
    repoInstallationId: bigint({ mode: "number" }),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.teamId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    authorKind: authorKind().notNull(),
    /** Vide pour les agents, et pour un membre dont le compte a été supprimé. */
    authorUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    body: text().notNull(),
    replyToId: uuid().references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    mentions: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.projectId, t.createdAt)],
);

/**
 * Pièces jointes. Le contenu est rangé dans le stockage (Backblaze B2, ou le disque en
 * développement) sous `storageKey`. Une pièce envoyée mais jamais jointe à un message
 * garde `messageId` vide.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    uploaderId: uuid().references(() => users.id, { onDelete: "set null" }),
    messageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    name: text().notNull(),
    contentType: text().notNull(),
    size: integer().notNull(),
    storageKey: text().notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.messageId)],
);

/** Mémoire du projet : décisions, questions ouvertes, tâches et compromis. */
export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: memoryType().notNull(),
    status: memoryStatus().notNull().default("open"),
    text: text().notNull(),
    sourceMessageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    /** Auteur du message d'origine, ou l'agent quand il propose lui-même (compromis). */
    proposedByKind: authorKind().notNull(),
    proposedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.projectId, t.status)],
);

/**
 * Chaque appel à une IA : de quoi mesurer la consommation (crédits) et repérer
 * les fournisseurs qui échouent. Le contenu des échanges n'est pas conservé ici.
 */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid().primaryKey().defaultRandom(),
    purpose: text().notNull(),
    teamId: uuid().references(() => teams.id, { onDelete: "set null" }),
    projectId: uuid().references(() => projects.id, { onDelete: "set null" }),
    provider: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    durationMs: integer().notNull(),
    ok: boolean().notNull(),
    error: text(),
    /** Membre pour qui l'appel a été fait, pour la consommation par membre. */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Crédits comptés pour cet appel, selon le barème du moment. */
    credits: doublePrecision().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.teamId, t.createdAt)],
);

export interface OrderStepRow {
  at: string;
  kind: "info" | "read" | "write" | "command" | "error";
  text: string;
}

/** Commandes passées au cuisinier. */
export const orders = pgTable(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    title: text().notNull(),
    brief: text().notNull(),
    status: orderStatus().notNull().default("pending"),
    requestedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    sourceMessageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    /** Tâche de la mémoire correspondante, résolue quand la commande aboutit. */
    memoryItemId: uuid().references(() => memoryItems.id, { onDelete: "set null" }),
    machineUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    machineSessionId: uuid().references(() => sessions.id, { onDelete: "set null" }),
    summary: text(),
    changedFiles: text().array().notNull().default(sql`'{}'::text[]`),
    /** Branche Git de la commande, son dernier commit et la date du push. */
    branch: text(),
    commitSha: text(),
    pushedAt: timestamp({ withTimezone: true }),
    /** Pull request ouverte à la validation, et date de sa fusion. */
    pullRequestNumber: integer(),
    pullRequestUrl: text(),
    mergedAt: timestamp({ withTimezone: true }),
    /** Note de reprise, et machine quittée : le relais ne doit pas y revenir. */
    handoffNote: text(),
    relayFromSessionId: uuid().references(() => sessions.id, { onDelete: "set null" }),
    /** « cloud » : sur la machine cloud de <br/>, pour une commande jugée non sensible. */
    runOn: text().$type<"member" | "cloud">().notNull().default("member"),
    steps: jsonb().$type<OrderStepRow[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.number), index().on(t.status)],
);

/**
 * Copie de sauvegarde de la mémoire locale d'un membre (`~/.bria/memoire.md`) : ses
 * préférences de travail. Elle sert à la restaurer sur une nouvelle machine, et le
 * cuisinier la lit avant de travailler chez lui.
 */
export const localMemories = pgTable("local_memories", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Secrets d'un projet. La valeur est chiffrée (AES-256-GCM) avec une clé qui n'est jamais
 * en base : elle vit dans les variables d'environnement du serveur.
 */
export const projectSecrets = pgTable(
  "project_secrets",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Valeur chiffrée, vecteur d'initialisation et étiquette d'authentification, en base64. */
    ciphertext: text().notNull(),
    iv: text().notNull(),
    tag: text().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.name)],
);

/** Membres autorisés à récupérer un secret (le chef l'est toujours). */
export const secretAccess = pgTable(
  "secret_access",
  {
    secretId: uuid()
      .notNull()
      .references(() => projectSecrets.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.secretId, t.userId] })],
);

/** Journal du coffre : qui a créé, modifié, supprimé ou récupéré quel secret, et quand. */
export const secretLog = pgTable(
  "secret_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    secretName: text().notNull(),
    action: text().$type<"created" | "updated" | "deleted" | "read">().notNull(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.projectId, t.createdAt)],
);

/** Retours des testeurs, envoyés depuis l'extension et suivis dans le tableau de bord. */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    projectId: uuid().references(() => projects.id, { onDelete: "set null" }),
    text: text().notNull(),
    status: text().$type<"new" | "in_progress" | "done">().notNull().default("new"),
    extensionVersion: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.status, t.createdAt)],
);

/** Formules : limites de membres et de projets, quota mensuel de crédits. */
export const plans = pgTable("plans", {
  id: text().primaryKey(),
  name: text().notNull(),
  maxMembers: integer().notNull(),
  maxProjects: integer().notNull(),
  monthlyCredits: integer().notNull(),
  sortOrder: integer().notNull().default(0),
});

/** Réglages de la plateforme modifiables depuis le tableau de bord (barème des crédits, maintenance…). */
export const platformSettings = pgTable("platform_settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Crédits ajoutés au quota d'une équipe pour un mois (code promo, geste de l'administrateur). */
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: uuid().primaryKey().defaultRandom(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    credits: integer().notNull(),
    /** Mois concerné, « 2026-11 ». */
    month: text().notNull(),
    source: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.teamId, t.month)],
);

/**
 * Codes promotionnels. Sortes : formule offerte, essai d'une formule pendant quelques jours,
 * crédits en bonus, réduction en pourcentage ou d'un montant fixe (appliquée une fois le
 * paiement intégré). Les invitations à la bêta restent dans beta_invites.
 */
export const promoCodes = pgTable("promo_codes", {
  id: uuid().primaryKey().defaultRandom(),
  code: text().notNull().unique(),
  kind: text().$type<"plan" | "trial" | "credits" | "percent" | "amount">().notNull(),
  /** Formule offerte (plan) ou essayée (trial). */
  planId: text().references(() => plans.id),
  /** Durée de l'effet en mois (formule, crédits chaque mois) ; vide : une seule fois. */
  durationMonths: integer(),
  /** Effet sans fin, réservé aux comptes de l'équipe interne. */
  forever: boolean().notNull().default(false),
  credits: integer(),
  trialDays: integer(),
  percent: integer(),
  amountCents: integer(),
  expiresAt: timestamp({ withTimezone: true }),
  maxUses: integer(),
  usesCount: integer().notNull().default(0),
  onePerAccount: boolean().notNull().default(true),
  /** Seulement pour une équipe encore à l'essai et qui n'a jamais utilisé de code. */
  newCustomersOnly: boolean().notNull().default(false),
  /** Seulement pour une équipe qui a cette formule. */
  requiredPlanId: text().references(() => plans.id),
  /** Public, unique (généré en lot) ou parrainage. */
  sort: text().$type<"public" | "unique" | "referral">().notNull().default("public"),
  batch: text(),
  note: text(),
  disabledAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Utilisations des codes : par qui, pour quelle équipe, et quand. */
export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    codeId: uuid()
      .notNull()
      .references(() => promoCodes.id, { onDelete: "cascade" }),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    teamId: uuid().references(() => teams.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.codeId), index().on(t.teamId)],
);

/** Comptes de l'équipe interne, pour le tableau de bord d'administration. */
export const adminAccounts = pgTable("admin_accounts", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  name: text().notNull(),
  /** Empreinte scrypt du mot de passe ; jamais le mot de passe lui-même. */
  passwordHash: text().notNull(),
  /** Sections du tableau de bord auxquelles le compte a accès (voir auth/adminPermissions.ts). */
  permissions: jsonb().$type<string[]>().notNull().default([]),
  lastLoginAt: timestamp({ withTimezone: true }),
  disabledAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Journal des actions de l'équipe interne : chaque modification faite depuis le tableau de bord
 * (ou par le jeton du serveur), et les connexions. Les simples lectures n'y figurent pas.
 */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: uuid().primaryKey().defaultRandom(),
    adminId: uuid().references(() => adminAccounts.id, { onDelete: "set null" }),
    /** Nom au moment de l'action, gardé si le compte change ou disparaît. */
    actor: text().notNull(),
    action: text().notNull(),
    method: text().notNull(),
    route: text().notNull(),
    targetId: text(),
    /** Ce qui a été envoyé, sans mot de passe ni jeton. */
    detail: text(),
    statusCode: integer().notNull(),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.action)],
);

/** Sessions du tableau de bord : seule l'empreinte du jeton est gardée. */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    adminId: uuid()
      .notNull()
      .references(() => adminAccounts.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.adminId)],
);
