/**
 * Autorisations des comptes de l'équipe interne : une par section du tableau de bord.
 * « utilisateurs » donne la section entière (consulter et agir) ; « utilisateurs:lecture »
 * permet seulement de la consulter. La vue d'ensemble et la liste des formules restent
 * ouvertes à tous les comptes.
 */
export const ADMIN_PERMISSIONS = [
  "statistiques",
  "utilisateurs",
  "equipes",
  "couts",
  "codes",
  "demandes",
  "retours",
  "maintenance",
  "comptes",
  "reglages",
  "journal",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Toutes les valeurs acceptées : chaque section, en entier ou en lecture seule. */
export const ADMIN_GRANTS = ADMIN_PERMISSIONS.flatMap((permission) => [
  permission,
  `${permission}:lecture` as const,
]) as [AdminPermission | `${AdminPermission}:lecture`, ...(AdminPermission | `${AdminPermission}:lecture`)[]];

/** Routes ouvertes à tout compte connecté. */
const OPEN = new Set(["GET /admin/overview", "GET /admin/plans"]);

const BY_PREFIX: [string, AdminPermission][] = [
  ["/admin/statistics", "statistiques"],
  ["/admin/audit", "journal"],
  ["/admin/users", "utilisateurs"],
  ["/admin/teams", "equipes"],
  ["/admin/costs", "couts"],
  ["/admin/promo-codes", "codes"],
  ["/admin/beta-requests", "demandes"],
  ["/admin/feedback", "retours"],
  ["/admin/maintenance", "maintenance"],
  ["/admin/cloud-machines", "reglages"],
  ["/admin/pending-orders", "maintenance"],
  ["/admin/admins", "comptes"],
  ["/admin/plans", "reglages"],
  ["/admin/credit-rates", "reglages"],
];

/**
 * Autorisation exigée par une route /admin (`url` est le modèle de la route, comme
 * « /admin/users/:id »). `null` : ouverte à tous ; `"all"` : route inconnue, réservée aux
 * comptes qui ont tout.
 */
export function requiredPermission(method: string, url: string): AdminPermission | null | "all" {
  if (OPEN.has(`${method} ${url}`)) return null;
  const match = BY_PREFIX.find(([prefix]) => url === prefix || url.startsWith(`${prefix}/`));
  return match ? match[1] : "all";
}

/** Une lecture (GET) se contente de la lecture seule ; toute autre méthode demande la section entière. */
export function allowed(
  permissions: readonly string[],
  required: AdminPermission | null | "all",
  method = "GET",
): boolean {
  if (required === null) return true;
  if (required === "all") return ADMIN_PERMISSIONS.every((permission) => permissions.includes(permission));
  if (permissions.includes(required)) return true;
  return (method === "GET" || method === "HEAD") && permissions.includes(`${required}:lecture`);
}
