import type { Project } from "@br-ia/protocol";
import { projects } from "../db/schema.ts";

/** Colonnes nécessaires pour décrire un projet à l'extension. */
export const projectColumns = {
  id: projects.id,
  teamId: projects.teamId,
  name: projects.name,
  repoFullName: projects.repoFullName,
  repoDefaultBranch: projects.repoDefaultBranch,
  repoInstallationId: projects.repoInstallationId,
};

export function toProject(row: {
  id: string;
  teamId: string;
  name: string;
  repoFullName: string | null;
  repoDefaultBranch: string | null;
  repoInstallationId: number | null;
}): Project {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    repo:
      row.repoFullName && row.repoDefaultBranch
        ? {
            fullName: row.repoFullName,
            defaultBranch: row.repoDefaultBranch,
            appConnected: row.repoInstallationId !== null,
          }
        : null,
  };
}

/** Branche d'une commande : bria/<numéro>-<titre en minuscules, sans accents ni espaces>. */
export function orderBranch(number: number, title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `bria/${number}-${slug}`;
}
