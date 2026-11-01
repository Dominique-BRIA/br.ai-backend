import type { MaintenanceStatus } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { platformSettings } from "../db/schema.ts";

/** Maintenance programmée par un administrateur (réglage « maintenance »). */
export interface Maintenance {
  startsAt: string;
  durationMinutes: number;
  messageFr: string;
  messageEn: string;
  /** Adresses des comptes qui gardent l'accès. */
  exceptions: string[];
}

const KEY = "maintenance";
const cache = new WeakMap<AppContext, Maintenance | null>();
const timers = new WeakMap<AppContext, NodeJS.Timeout>();

export async function getMaintenance(ctx: AppContext): Promise<Maintenance | null> {
  if (cache.has(ctx)) return cache.get(ctx) ?? null;
  const [row] = await ctx.db.select().from(platformSettings).where(eq(platformSettings.key, KEY));
  const value = (row?.value as Maintenance | null | undefined) ?? null;
  cache.set(ctx, value);
  return value;
}

/** L'état vu par un compte (les exceptions gardent l'accès). */
export function maintenanceStatus(maintenance: Maintenance | null, email?: string): MaintenanceStatus {
  if (!maintenance) {
    return { state: "none", startsAt: null, endsAt: null, message: { fr: "", en: "" }, exempt: false };
  }
  const start = new Date(maintenance.startsAt);
  return {
    state: start.getTime() > Date.now() ? "scheduled" : "ongoing",
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + maintenance.durationMinutes * 60_000).toISOString(),
    message: { fr: maintenance.messageFr, en: maintenance.messageEn },
    exempt: email ? maintenance.exceptions.includes(email.toLowerCase()) : false,
  };
}

/** Vrai si ce compte est bloqué maintenant (maintenance en cours, et pas dans les exceptions). */
export async function blockedByMaintenance(ctx: AppContext, email: string): Promise<boolean> {
  const status = maintenanceStatus(await getMaintenance(ctx), email);
  return status.state === "ongoing" && !status.exempt;
}

/** Prévient toutes les machines connectées de l'état de la plateforme, chacune selon son compte. */
async function broadcast(ctx: AppContext, reopened: boolean): Promise<void> {
  const maintenance = await getMaintenance(ctx);
  for (const connection of ctx.hub.all()) {
    connection.send({
      type: "platform.status",
      maintenance: maintenanceStatus(maintenance, connection.email),
      reopened,
    });
  }
}

/** Au début de la maintenance, les machines sont prévenues que l'accès se ferme. */
function scheduleStart(ctx: AppContext, maintenance: Maintenance | null): void {
  clearTimeout(timers.get(ctx));
  if (!maintenance) return;
  const delay = new Date(maintenance.startsAt).getTime() - Date.now();
  if (delay <= 0) return;
  // setTimeout n'accepte pas plus de 24,8 jours ; au-delà, on se réarme plus tard.
  const timer = setTimeout(
    () => {
      if (delay > 2_000_000_000) scheduleStart(ctx, maintenance);
      else void broadcast(ctx, false);
    },
    Math.min(delay, 2_000_000_000),
  );
  timer.unref();
  timers.set(ctx, timer);
}

/** À l'ouverture du serveur : reprend le minuteur d'une maintenance déjà programmée. */
export async function resumeMaintenance(ctx: AppContext): Promise<void> {
  scheduleStart(ctx, await getMaintenance(ctx));
}

/** Programme (ou remplace) la maintenance et l'annonce aux machines connectées. */
export async function scheduleMaintenance(ctx: AppContext, maintenance: Maintenance): Promise<void> {
  await ctx.db
    .insert(platformSettings)
    .values({ key: KEY, value: maintenance })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: maintenance, updatedAt: new Date() } });
  cache.set(ctx, maintenance);
  scheduleStart(ctx, maintenance);
  await broadcast(ctx, false);
}

/** Rouvre la plateforme : la maintenance est effacée et les machines sont prévenues. */
export async function reopenPlatform(ctx: AppContext): Promise<void> {
  await ctx.db.delete(platformSettings).where(eq(platformSettings.key, KEY));
  cache.set(ctx, null);
  scheduleStart(ctx, null);
  await broadcast(ctx, true);
}
