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
} as const;

export type CookToolName = keyof typeof cookTools;
export type CookToolInput<T extends CookToolName> = z.output<(typeof cookTools)[T]["input"]>;

export function isCookTool(name: string): name is CookToolName {
  return Object.hasOwn(cookTools, name);
}

/** Outils qui modifient la machine : ils demandent une validation selon le mode choisi. */
export const WRITE_TOOLS: CookToolName[] = ["write_file", "edit_file"];
export const COMMAND_TOOLS: CookToolName[] = ["run_command"];
