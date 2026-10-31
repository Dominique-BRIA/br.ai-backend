import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4000),
  /** Dossier de la base PGlite locale, utilisée en développement. */
  PGLITE_DIR: z.string().default(".data/pglite"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Configuration invalide : ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
