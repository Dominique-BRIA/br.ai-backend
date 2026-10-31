import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const locale = pgEnum("locale", ["fr", "en"]);

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  displayName: text().notNull(),
  locale: locale().notNull().default("fr"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId)],
);
