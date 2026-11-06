import { z } from "zod";

/**
 * Les outils du cuisinier. Le serveur les propose à l'IA ; la machine du membre
 * les exécute dans le dossier du projet, après validation selon son mode de permission.
 * Les chemins sont relatifs au dossier du projet.
 */
export const cookTools = {
  read_file: {
    description: "Lit un fichier texte du projet.",
    input: z.object({ path: z.string().min(1).describe("Chemin relatif au dossier du projet.") }),
  },
  list_dir: {
    description: "Liste le contenu d'un dossier du projet (sans node_modules, .git, dist).",
    input: z.object({ path: z.string().default(".").describe("Chemin relatif ; « . » pour la racine.") }),
  },
  search: {
    description: "Cherche un texte dans les fichiers du projet. Renvoie au plus 50 lignes trouvées.",
    input: z.object({
      query: z.string().min(1).describe("Texte à chercher (sensible à la casse)."),
      path: z.string().default(".").describe("Dossier où chercher."),
    }),
  },
  write_file: {
    description: "Crée un fichier ou remplace entièrement son contenu.",
    input: z.object({
      path: z.string().min(1),
      content: z.string().describe("Contenu complet du fichier."),
    }),
  },
  edit_file: {
    description:
      "Remplace un passage exact d'un fichier existant. Le texte à remplacer doit apparaître une seule fois.",
    input: z.object({
      path: z.string().min(1),
      old_text: z.string().min(1).describe("Passage actuel, recopié exactement."),
      new_text: z.string().describe("Nouveau passage."),
    }),
  },
  run_command: {
    description:
      "Lance une commande dans le dossier du projet (tests, compilation, installation de dépendances…) et renvoie sa sortie.",
    input: z.object({
      command: z.string().min(1),
      timeout_seconds: z.number().int().min(5).max(600).default(120),
    }),
  },
  check_environment: {
    description: "Indique le système, l'interpréteur de commandes et les versions des outils installés.",
    input: z.object({}),
  },
  write_env: {
    description:
      "Écrit le fichier .env du projet avec les secrets du coffre auxquels le propriétaire de la machine a accès, et l'ajoute au .gitignore. Tu ne vois jamais les valeurs : seulement les noms écrits.",
    input: z.object({
      path: z.string().default(".env").describe("Chemin du fichier, relatif au dossier du projet."),
    }),
  },
} as const;

export type CookToolName = keyof typeof cookTools;

/** Nom de branche d'une commande : bria/<numéro>-<titre court>. */
export const orderBranchPattern = /^bria\/[0-9]+-[a-z0-9-]{0,60}$/;

/**
 * Outils Git du cuisinier. C'est le serveur qui les lance, autour du travail de l'IA, qui ne
 * les voit jamais : une branche par commande, puis un commit au nom du membre et le push.
 */
export const gitTools = {
  /** Prépare la branche de la commande à partir de la branche principale (ou la reprend). */
  git_prepare: {
    input: z.object({
      branch: z.string().regex(orderBranchPattern),
      base: z.string().min(1).max(200),
    }),
  },
  /** Enregistre le travail dans un commit, puis pousse la branche selon la préférence du membre. */
  git_save: {
    input: z.object({
      branch: z.string().regex(orderBranchPattern),
      message: z.string().min(1).max(4000),
      /** Relais : le membre a déjà donné son accord, on pousse sans redemander. */
      push: z.boolean().optional(),
    }),
  },
} as const;
export type GitToolName = keyof typeof gitTools;

export function isGitTool(name: string): name is GitToolName {
  return Object.hasOwn(gitTools, name);
}

/** Réponse de git_save, renvoyée en JSON dans la sortie de l'outil. */
export const gitSaveResult = z.object({
  commit: z.string().nullable(),
  pushed: z.boolean(),
  note: z.string(),
});
export type GitSaveResult = z.infer<typeof gitSaveResult>;
export type CookToolInput<T extends CookToolName> = z.output<(typeof cookTools)[T]["input"]>;

export function isCookTool(name: string): name is CookToolName {
  return Object.hasOwn(cookTools, name);
}

/** Outils qui modifient la machine : ils demandent une validation selon le mode choisi. */
export const WRITE_TOOLS: CookToolName[] = ["write_file", "edit_file"];
export const COMMAND_TOOLS: CookToolName[] = ["run_command"];

/**
 * Outils internes de la machine cloud, demandés par le serveur autour du travail de l'IA (l'IA ne
 * les voit pas) : préparer le dossier de travail, rendre les fichiers créés, faire le ménage.
 */
export const cloudTools = {
  cloud_prepare: {
    input: z.object({
      /** Le projet : sans dépôt, son espace réservé est conservé d'une commande à l'autre. */
      space: z.uuid(),
      /** Projet avec dépôt : de quoi le cloner et commiter au nom du demandeur ; sinon son espace. */
      repo: z
        .object({
          fullName: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
          /** Jeton d'installation de l'application GitHub, limité au dépôt et valable une heure. */
          token: z.string().min(1).max(500),
          author: z.object({ name: z.string().min(1).max(100), email: z.string().min(3).max(200) }),
        })
        .nullable(),
    }),
  },
  /** Met les fichiers du dossier dans un .zip et l'envoie au serveur. */
  cloud_collect: { input: z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }) },
  cloud_cleanup: { input: z.object({}) },
} as const;
export type CloudToolName = keyof typeof cloudTools;

export function isCloudTool(name: string): name is CloudToolName {
  return Object.hasOwn(cloudTools, name);
}

/** Réponse de cloud_collect : la pièce jointe créée (ou pourquoi il n'y en a pas). */
export const cloudCollectResult = z.object({
  attachmentId: z.uuid().nullable(),
  files: z.number().int().nonnegative(),
  note: z.string(),
});
export type CloudCollectResult = z.infer<typeof cloudCollectResult>;
