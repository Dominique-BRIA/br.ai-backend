import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
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
    async ping(): Promise<boolean> {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.close(),
  };
}
