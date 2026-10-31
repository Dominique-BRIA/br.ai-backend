import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
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

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  displayName: text().notNull(),
  locale: locale().notNull().default("fr"),
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
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.email, t.createdAt)],
);

export const teams = pgTable("teams", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
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
