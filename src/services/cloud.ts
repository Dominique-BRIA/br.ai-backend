import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { sessions } from "../db/schema.ts";

/**
 * Compte de service de la machine cloud du cuisinier, créé par la migration. Il n'appartient à
 * aucune équipe, et personne ne peut s'y connecter : son adresse est refusée à la connexion.
 */
export const CLOUD_USER_ID = "00000000-0000-4000-8000-00000000c10d";
export const CLOUD_EMAIL = "machine-cloud@service.invalid";
export const CLOUD_DISPLAY_NAME = "Machine cloud <br/>";

/** Durée maximale d'une commande sur la machine cloud, partagée par toutes les équipes. */
export const CLOUD_MAX_MS = 20 * 60_000;

/** Une machine cloud est enregistrée (connectée ou non) : on peut lui confier des commandes. */
export async function cloudConfigured(ctx: AppContext): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, CLOUD_USER_ID), isNull(sessions.revokedAt)))
    .limit(1);
  return Boolean(row);
}

/** Adresse d'auteur des commits faits pour un membre sur la machine cloud : jamais son vrai e-mail. */
export const noreplyEmail = (userId: string) => `${userId}@users.noreply.br.garah.me`;
