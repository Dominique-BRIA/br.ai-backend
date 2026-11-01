import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import {
  aiCalls,
  creditGrants,
  plans,
  platformSettings,
  projects,
  teamMembers,
  teams,
} from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { postAgentMessage } from "./messages.ts";

/** Crédits pour 1000 jetons, en entrée et en sortie. */
export interface Rate {
  input: number;
  output: number;
}

/** Barème : un tarif par défaut, et des tarifs par modèle (« fournisseur:modèle »). */
export interface CreditRates {
  default: Rate;
  models: Record<string, Rate>;
}

export type Plan = typeof plans.$inferSelect;

const FALLBACK_RATES: CreditRates = { default: { input: 1, output: 3 }, models: {} };
/** À partir de cette part du quota, le chef est prévenu. */
const WARNING_RATIO = 0.8;

const ratesCache = new WeakMap<AppContext, CreditRates>();

export async function creditRates(ctx: AppContext): Promise<CreditRates> {
  const cached = ratesCache.get(ctx);
  if (cached) return cached;
  const [row] = await ctx.db.select().from(platformSettings).where(eq(platformSettings.key, "creditRates"));
  const rates = (row?.value as CreditRates | undefined) ?? FALLBACK_RATES;
  ratesCache.set(ctx, rates);
  return rates;
}

export async function saveCreditRates(ctx: AppContext, rates: CreditRates): Promise<void> {
  await ctx.db
    .insert(platformSettings)
    .values({ key: "creditRates", value: rates })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: rates, updatedAt: new Date() } });
  ratesCache.set(ctx, rates);
}

/** Crédits d'un appel, arrondis au centième. */
export function creditsFor(
  rates: CreditRates,
  provider: string,
  model: string,
  input: number,
  output: number,
) {
  const rate = rates.models[`${provider}:${model}`] ?? rates.default;
  return Math.round(((input / 1000) * rate.input + (output / 1000) * rate.output) * 100) / 100;
}

/** Mois en cours, « 2026-11 » (en temps universel). */
export const currentMonth = (date = new Date()) => date.toISOString().slice(0, 7);
const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000Z`);

/** La formule en vigueur : à sa date de fin, l'équipe revient à l'essai. */
export async function teamPlan(
  ctx: AppContext,
  teamId: string,
): Promise<{ plan: Plan; endsAt: Date | null }> {
  const [team] = await ctx.db
    .select({ planId: teams.planId, planEndsAt: teams.planEndsAt })
    .from(teams)
    .where(eq(teams.id, teamId));
  const expired = team?.planEndsAt ? team.planEndsAt.getTime() < Date.now() : false;
  const planId = !team || expired ? "essai" : team.planId;
  const [plan] = await ctx.db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw new Error(`Formule inconnue : ${planId}`);
  return { plan, endsAt: expired ? null : (team?.planEndsAt ?? null) };
}

/** Consommation du mois : crédits utilisés (au total et par membre) et quota. */
export async function teamUsage(ctx: AppContext, teamId: string, month = currentMonth()) {
  const { plan, endsAt } = await teamPlan(ctx, teamId);
  const since = monthStart(month);
  const byMember = await ctx.db
    .select({ userId: aiCalls.userId, credits: sql<number>`coalesce(sum(${aiCalls.credits}), 0)` })
    .from(aiCalls)
    .where(and(eq(aiCalls.teamId, teamId), gte(aiCalls.createdAt, since)))
    .groupBy(aiCalls.userId);
  const [granted] = await ctx.db
    .select({ credits: sql<number>`coalesce(sum(${creditGrants.credits}), 0)` })
    .from(creditGrants)
    .where(and(eq(creditGrants.teamId, teamId), eq(creditGrants.month, month)));
  const round = (value: number) => Math.round(Number(value) * 100) / 100;
  const used = round(byMember.reduce((total, row) => total + Number(row.credits), 0));
  const bonus = Number(granted?.credits ?? 0);
  return {
    plan,
    endsAt,
    month,
    used,
    bonus,
    quota: plan.monthlyCredits + bonus,
    byMember: byMember.map((row) => ({ userId: row.userId, credits: round(row.credits) })),
  };
}

/** Vrai quand l'équipe a utilisé tout son quota du mois : les nouvelles commandes sont refusées. */
export async function quotaReached(ctx: AppContext, teamId: string): Promise<boolean> {
  const usage = await teamUsage(ctx, teamId);
  return usage.used >= usage.quota;
}

/**
 * Après un appel d'IA : à 80 % puis à 100 % du quota, le serveur prévient le chef dans le
 * projet concerné, une seule fois par mois.
 */
export async function afterAiUsage(ctx: AppContext, teamId: string, projectId: string | undefined) {
  if (!projectId) return;
  const usage = await teamUsage(ctx, teamId);
  const ratio = usage.quota > 0 ? usage.used / usage.quota : 1;
  if (ratio < WARNING_RATIO) return;
  const exceeded = ratio >= 1;
  const column = exceeded ? teams.quotaExceededMonth : teams.quotaWarnedMonth;
  // La mise à jour conditionnelle garantit qu'un seul appel envoie l'alerte.
  const [claimed] = await ctx.db
    .update(teams)
    .set(exceeded ? { quotaExceededMonth: usage.month } : { quotaWarnedMonth: usage.month })
    .where(and(eq(teams.id, teamId), sql`${column} is distinct from ${usage.month}`))
    .returning({ id: teams.id });
  if (!claimed) return;

  const chefs = await ctx.db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "chef")));
  const amount = `${Math.round(usage.used)} sur ${usage.quota}`;
  await postAgentMessage(ctx, {
    projectId,
    teamId,
    kind: "serveur",
    body: exceeded
      ? `L'équipe a utilisé tous ses crédits du mois (${amount}). Les nouvelles commandes au cuisinier sont refusées jusqu'au mois prochain ; je continue de répondre dans le chat. Le chef peut saisir un code ou changer de formule.`
      : `L'équipe a utilisé ${Math.round(ratio * 100)} % de ses crédits du mois (${amount}).`,
    mentions: chefs.map((chef) => chef.userId),
  });
}

/** Refuse d'ajouter un membre ou un projet au-delà des limites de la formule. */
export async function requireWithinPlan(ctx: AppContext, teamId: string, kind: "members" | "projects") {
  const { plan } = await teamPlan(ctx, teamId);
  const [row] =
    kind === "members"
      ? await ctx.db.select({ total: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId))
      : await ctx.db
          .select({ total: count() })
          .from(projects)
          .where(and(eq(projects.teamId, teamId), isNull(projects.archivedAt)));
  const limit = kind === "members" ? plan.maxMembers : plan.maxProjects;
  if ((row?.total ?? 0) >= limit) {
    throw new HttpError(
      403,
      "plan_limit",
      kind === "members"
        ? `La formule ${plan.name} de cette équipe est limitée à ${limit} membre(s).`
        : `La formule ${plan.name} de cette équipe est limitée à ${limit} projet(s).`,
    );
  }
}
