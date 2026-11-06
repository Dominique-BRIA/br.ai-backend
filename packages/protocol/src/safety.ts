import { isAbsolute, relative, resolve } from "node:path";

/**
 * Règles de sécurité du cuisinier, appliquées sur la machine quel que soit le mode :
 * le dossier du projet est une frontière, et certaines commandes exigent toujours un accord.
 */

/** Chemin absolu d'un chemin relatif au projet ; `inside` est faux s'il en sort. */
export function resolveInProject(root: string, path: string): { absolute: string; inside: boolean } {
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  const inside = fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  return { absolute, inside };
}

const DANGEROUS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-\w*[rf]\w*\s+)+/i, reason: "suppression de fichiers" },
  { pattern: /\b(del|erase)\b.*\s\/[sq]\b/i, reason: "suppression de fichiers" },
  { pattern: /\b(rd|rmdir)\b.*\s\/s\b/i, reason: "suppression de dossiers" },
  { pattern: /\bremove-item\b.*-recurse/i, reason: "suppression de dossiers" },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/i, reason: "réécriture de l'historique distant" },
  {
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-\w*f|rebase|filter-branch)\b/i,
    reason: "réécriture de l'historique Git",
  },
  { pattern: /\b(npm|pnpm|yarn)\s+(i|install|add)\b.*(\s-g\b|--global)/i, reason: "installation globale" },
  {
    pattern: /\bpip3?\s+install\b(?!.*(-r\s|--requirement|\s-e\s|--user|\.))/i,
    reason: "installation Python hors projet",
  },
  // « format C: » seulement : « npm run format » est une commande courante.
  { pattern: /\bformat\s+[a-z]:|\b(diskpart|mkfs|shutdown|reboot)\b/i, reason: "commande système" },
  {
    pattern: /\b(curl|wget|iwr|invoke-webrequest)\b.*\|\s*(sh|bash|iex|invoke-expression|powershell)/i,
    reason: "exécution d'un script téléchargé",
  },
  { pattern: /\bset-executionpolicy\b|\breg\s+(add|delete)\b/i, reason: "modification du système" },
  { pattern: /\bchmod\s+-R\b|\bchown\s+-R\b/i, reason: "changement de droits en masse" },
  { pattern: /\bsudo\b|\brunas\b/i, reason: "élévation de privilèges" },
];

/** Raison pour laquelle une commande est dangereuse, ou `null`. */
export function dangerousCommand(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS) if (pattern.test(command)) return reason;
  return null;
}

/** Dossiers ignorés quand on parcourt le projet. */
export const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".data",
]);
