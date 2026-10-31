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
  /** Clés des fournisseurs d'IA (offres gratuites pendant la bêta). */
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  /** Modèles de l'agent serveur, « fournisseur:modèle » séparés par des virgules, dans l'ordre d'essai. */
  AI_SERVEUR_CHAIN: z
    .string()
    .default(
      "gemini:gemini-3.5-flash-lite,gemini:gemini-3.1-flash-lite,groq:openai/gpt-oss-120b,gemini:gemini-flash-lite-latest",
    ),
  /** Modèles du cuisinier (ils doivent savoir appeler des outils), dans l'ordre d'essai. */
  AI_CUISINIER_CHAIN: z.string().default("mistral:codestral-latest,gemini:gemini-3.5-flash"),
  /** Dossier des pièces jointes quand Backblaze B2 n'est pas configuré. */
  FILES_DIR: z.string().default(".data/files"),
  /** Backblaze B2 : les quatre variables, ou aucune. */
  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),
  B2_BUCKET: z.string().optional(),
  B2_ENDPOINT: z.url().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Configuration invalide : ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
