import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4000),
  /**
   * Base PostgreSQL de production (Neon) : l'adresse avec pooler pour les requêtes, la connexion
   * directe pour les migrations. Utilisées seulement quand NODE_ENV vaut « production ».
   */
  DATABASE_URL: z.string().trim().optional(),
  DATABASE_DIRECT: z.string().trim().optional(),
  /** Dossier de la base PGlite locale, utilisée en développement. */
  PGLITE_DIR: z.string().default(".data/pglite"),
  /** Jeton des routes d'administration (`x-admin-token`). Sans lui, ces routes sont fermées. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Clé Resend. Sans elle, les e-mails sont seulement écrits dans le journal. */
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("‹br/› <onboarding@resend.dev>"),
  /** Clés des fournisseurs d'IA (offres gratuites pendant la bêta). */
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  /** Z.ai : modèles GLM Flash gratuits, en dernier secours (les données passent par la Chine). */
  ZAI_API_KEY: z.string().optional(),
  /** Modèles de l'agent serveur, « fournisseur:modèle » séparés par des virgules, dans l'ordre d'essai. */
  AI_SERVEUR_CHAIN: z
    .string()
    .default(
      "gemini:gemini-3.5-flash-lite,gemini:gemini-3.1-flash-lite,groq:openai/gpt-oss-120b,gemini:gemini-flash-lite-latest,zai:glm-4.5-flash",
    ),
  /**
   * Modèles du cuisinier (ils doivent savoir appeler des outils), dans l'ordre d'essai : Gemini 3.6 Flash
   * d'abord, plus fort en agent ; Codestral puis gpt-oss-120b (Groq) prennent le relais quand
   * l'offre gratuite de Gemini refuse.
   */
  AI_CUISINIER_CHAIN: z
    .string()
    .default(
      "gemini:gemini-3.6-flash,mistral:codestral-latest,groq:openai/gpt-oss-120b,gemini:gemini-3.5-flash,zai:glm-4.7-flash,zai:glm-4.5-flash",
    ),
  /**
   * Application GitHub de <br/>, facultative : toutes ces variables, ou aucune. La clé privée se
   * donne par son contenu (les retours à la ligne écrits \\n) ou par le chemin de son fichier.
   */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  /** Clé maîtresse du coffre de secrets : 32 octets en base64. Sans elle, le coffre est fermé. */
  SECRETS_KEY: z.string().optional(),
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
