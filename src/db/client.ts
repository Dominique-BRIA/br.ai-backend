import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Database = Awaited<ReturnType<typeof openDatabase>>;

/**
 * Ouvre la base PGlite et applique les migrations du dossier `drizzle/`,
 * relatif au dossier de lancement du serveur.
 * `dataDir` absent : base en mémoire (tests).
 */
export async function openDatabase(dataDir?: string) {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle({ client, schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: "drizzle" });

  return {
    db,
    ping: () => ping(db),
    close: () => client.close(),
  };
}

/**
 * Ouvre une base PostgreSQL (Neon en ligne) et applique les migrations. Les requêtes passent
 * par `url`, l'adresse avec pooler ; les migrations par `directUrl`, la connexion directe, car le
 * pooler de Neon (mode transaction) ne garde pas les verrous de session dont elles ont besoin.
 */
export async function openPostgres(url: string, directUrl = url): Promise<Database> {
  const migrator = postgres(directUrl, { max: 1, onnotice: () => {} });
  try {
    await migratePostgres(drizzlePostgres({ client: migrator, schema, casing: "snake_case" }), {
      migrationsFolder: "drizzle",
    });
  } finally {
    await migrator.end();
  }

  // Sans requêtes préparées : le pooler ne garantit pas la même connexion d'une requête à l'autre.
  const client = postgres(url, { max: 10, prepare: false, onnotice: () => {} });
  const db = drizzlePostgres({ client, schema, casing: "snake_case" });
  // Les deux pilotes exposent la même API Drizzle pour PostgreSQL ; le code du serveur ne
  // dépend pas de la forme brute des résultats, seule différence entre eux.
  return {
    db: db as unknown as Database["db"],
    ping: () => ping(db),
    close: async () => {
      await client.end();
    },
  };
}

async function ping(db: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
