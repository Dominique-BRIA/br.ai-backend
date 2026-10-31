import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4000),
  /** Dossier de la base PGlite locale, utilisée en développement. */
  PGLITE_DIR: z.string().default(".data/pglite"),
  /** Jeton des routes d'administration (`x-admin-token`). Sans lui, ces routes sont fermées. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Clé Resend. Sans elle, les e-mails sont seulement écrits dans le journal. */
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("br.ia <onboarding@resend.dev>"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Configuration invalide : ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
