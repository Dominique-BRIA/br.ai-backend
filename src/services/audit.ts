import type { FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { adminAudit } from "../db/schema.ts";

/** Le verbe de chaque route qui modifie quelque chose, tel qu'il s'affiche dans le journal. */
const ACTIONS: Record<string, string> = {
  "POST /admin/admins": "Compte admin créé",
  "PATCH /admin/admins/:id": "Accès d'un compte modifié",
  "PATCH /admin/users/:id": "Utilisateur modifié",
  "PATCH /admin/teams/:id": "Équipe modifiée",
  "PATCH /admin/plans/:id": "Formule modifiée",
  "PUT /admin/credit-rates": "Barème modifié",
  "PATCH /admin/feedback/:id": "Retour mis à jour",
  "PUT /admin/maintenance": "Maintenance programmée",
  "DELETE /admin/maintenance": "Plateforme rouverte",
  "POST /admin/promo-codes": "Codes promo créés",
  "PATCH /admin/promo-codes/:id": "Code promo modifié",
  "POST /admin/beta-requests/:id/invite": "Invitation bêta envoyée",
  "POST /admin/beta-requests/:id/resend": "Invitation bêta renvoyée",
};

/** Une route qui modifie sans verbe décrit ci-dessus : à compléter, le journal le signale. */
export const UNMAPPED = "Action non décrite";

export function describeAction(method: string, route: string): string {
  return ACTIONS[`${method} ${route}`] ?? UNMAPPED;
}

/** Le corps de la requête, lisible et sans secret, pour la colonne « Détail ». */
export function auditDetail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const clean = Object.entries(body as Record<string, unknown>).filter(
    ([key]) => !/password|token|secret/i.test(key),
  );
  if (clean.length === 0) return null;
  const text = clean
    .map(([key, value]) => `${key} : ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

export interface AuditEntry {
  adminId: string | null;
  actor: string;
  action: string;
  request: FastifyRequest;
  statusCode: number;
  targetId?: string | null;
  detail?: string | null;
}

/** Écrit une ligne du journal ; une erreur d'écriture ne fait jamais échouer l'action elle-même. */
export async function recordAudit(ctx: AppContext, entry: AuditEntry): Promise<void> {
  const { request } = entry;
  await ctx.db
    .insert(adminAudit)
    .values({
      adminId: entry.adminId,
      actor: entry.actor,
      action: entry.action,
      method: request.method,
      route: request.routeOptions.url ?? request.url,
      targetId: entry.targetId ?? null,
      detail: entry.detail ?? null,
      statusCode: entry.statusCode,
      ip: request.ip,
    })
    .catch((error: unknown) => request.log.warn({ error }, "Journal d'administration non écrit"));
}
