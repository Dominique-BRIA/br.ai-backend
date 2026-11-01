import { randomBytes } from "node:crypto";
import type { createPromoBody, PromoCode } from "@br-ia/protocol";
import { and, count, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { newInvitationCode } from "../auth/secrets.ts";
import type { AppContext } from "../context.ts";
import { betaInvites, creditGrants, plans, promoCodes, promoRedemptions, teams } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { currentMonth, teamPlan } from "./credits.ts";

type PromoRow = typeof promoCodes.$inferSelect;
/** Corps validé d'une création de codes. */
export type NewPromo = z.output<typeof createPromoBody>;

const addMonths = (date: Date, months: number) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

/**
 * Le chef saisit un code pour son équipe. Toutes les limites du code sont vérifiées, puis
 * son effet est appliqué ; renvoie ce qu'il a changé, en une phrase.
 */
export async function redeemPromo(
  ctx: AppContext,
  teamId: string,
  userId: string,
  raw: string,
): Promise<string> {
  const code = raw.trim().toUpperCase();
  const [promo] = await ctx.db.select().from(promoCodes).where(eq(promoCodes.code, code));
  if (!promo || promo.disabledAt) throw new HttpError(404, "promo_invalid", "Ce code n'est pas valable.");
  if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
    throw new HttpError(410, "promo_expired", "Ce code a expiré.");
  }
  if (promo.maxUses !== null && promo.usesCount >= promo.maxUses) {
    throw new HttpError(410, "promo_exhausted", "Ce code a déjà été utilisé le nombre de fois prévu.");
  }
  if (promo.onePerAccount) {
    const [used] = await ctx.db
      .select({ total: count() })
      .from(promoRedemptions)
      .where(and(eq(promoRedemptions.codeId, promo.id), eq(promoRedemptions.userId, userId)));
    if ((used?.total ?? 0) > 0)
      throw new HttpError(409, "promo_already_used", "Vous avez déjà utilisé ce code.");
  }
  const { plan, endsAt } = await teamPlan(ctx, teamId);
  if (promo.newCustomersOnly) {
    const [earlier] = await ctx.db
      .select({ total: count() })
      .from(promoRedemptions)
      .where(eq(promoRedemptions.teamId, teamId));
    if (plan.id !== "essai" || (earlier?.total ?? 0) > 0) {
      throw new HttpError(403, "promo_not_eligible", "Ce code est réservé aux nouvelles équipes.");
    }
  }
  if (promo.requiredPlanId && promo.requiredPlanId !== plan.id) {
    throw new HttpError(403, "promo_not_eligible", "Ce code ne s'applique pas à la formule de votre équipe.");
  }

  const message = await applyPromo(ctx, teamId, promo, plan.id, endsAt);
  await ctx.db
    .update(promoCodes)
    .set({ usesCount: sql`${promoCodes.usesCount} + 1` })
    .where(eq(promoCodes.id, promo.id));
  await ctx.db.insert(promoRedemptions).values({ codeId: promo.id, userId, teamId });
  return message;
}

async function applyPromo(
  ctx: AppContext,
  teamId: string,
  promo: PromoRow,
  currentPlanId: string,
  currentEnd: Date | null,
): Promise<string> {
  const planName = async (id: string | null) =>
    (
      await ctx.db
        .select({ name: plans.name })
        .from(plans)
        .where(eq(plans.id, id ?? ""))
    )[0]?.name ?? "";
  const date = (value: Date) =>
    new Intl.DateTimeFormat("fr", { dateStyle: "long", timeZone: "UTC" }).format(value);

  switch (promo.kind) {
    case "plan": {
      const planEndsAt = promo.forever ? null : addMonths(new Date(), promo.durationMonths ?? 1);
      await ctx.db
        .update(teams)
        .set({ planId: promo.planId ?? "essai", planEndsAt })
        .where(eq(teams.id, teamId));
      const name = await planName(promo.planId);
      return planEndsAt
        ? `Formule ${name} jusqu'au ${date(planEndsAt)}.`
        : `Formule ${name}, sans limite de durée.`;
    }
    case "trial": {
      // Essai prolongé : la même formule repousse sa date de fin, sinon elle commence aujourd'hui.
      const days = promo.trialDays ?? 14;
      const start = currentPlanId === promo.planId && currentEnd ? currentEnd : new Date();
      const planEndsAt = addDays(start, days);
      await ctx.db
        .update(teams)
        .set({ planId: promo.planId ?? "essai", planEndsAt })
        .where(eq(teams.id, teamId));
      return `Essai de la formule ${await planName(promo.planId)} jusqu'au ${date(planEndsAt)}.`;
    }
    case "credits": {
      const months = promo.durationMonths ?? 1;
      const start = new Date();
      await ctx.db.insert(creditGrants).values(
        Array.from({ length: months }, (_, index) => ({
          teamId,
          credits: promo.credits ?? 0,
          month: currentMonth(
            addMonths(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)), index),
          ),
          source: `code ${promo.code}`,
        })),
      );
      return months > 1
        ? `${promo.credits} crédits en plus chaque mois pendant ${months} mois.`
        : `${promo.credits} crédits en plus ce mois-ci.`;
    }
    case "percent":
    case "amount":
      // Les réductions de prix ne s'appliqueront qu'une fois le paiement intégré.
      return promo.kind === "percent"
        ? `Réduction de ${promo.percent} % enregistrée : elle s'appliquera quand le paiement sera disponible.`
        : `Réduction de ${((promo.amountCents ?? 0) / 100).toFixed(2)} $ enregistrée : elle s'appliquera quand le paiement sera disponible.`;
  }
}

/** Code généré : préfixe et huit caractères faciles à lire. */
function generatedCode(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/**
 * Crée un code, ou un lot de codes uniques. Une invitation à la bêta est rangée avec les
 * autres invitations (beta_invites).
 */
export async function createPromoCodes(ctx: AppContext, body: NewPromo): Promise<string[]> {
  if (body.kind === "beta") {
    const codes: string[] = [];
    for (let index = 0; index < body.count; index++) {
      const code = body.count === 1 && body.code ? body.code : newInvitationCode("BETA");
      await ctx.db.insert(betaInvites).values({
        code,
        maxUses: body.maxUses ?? 1,
        note: body.note,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      codes.push(code);
    }
    return codes;
  }
  if ((body.kind === "plan" || body.kind === "trial") && !body.planId) {
    throw new HttpError(400, "invalid_request", "Choisissez la formule offerte.");
  }
  if (body.kind === "credits" && !body.credits)
    throw new HttpError(400, "invalid_request", "Indiquez les crédits.");
  if (body.kind === "percent" && !body.percent)
    throw new HttpError(400, "invalid_request", "Indiquez le pourcentage.");
  if (body.kind === "amount" && !body.amountCents)
    throw new HttpError(400, "invalid_request", "Indiquez le montant.");

  const batch = body.count > 1 ? `${body.prefix}-${Date.now().toString(36)}` : null;
  const codes = Array.from({ length: body.count }, () => generatedCode(body.prefix));
  if (body.count === 1 && body.code) codes[0] = body.code;
  for (const code of codes) {
    const [existing] = await ctx.db
      .select({ id: promoCodes.id })
      .from(promoCodes)
      .where(eq(promoCodes.code, code));
    if (existing) throw new HttpError(409, "invalid_request", `Le code ${code} existe déjà.`);
  }
  await ctx.db.insert(promoCodes).values(
    codes.map((code) => ({
      code,
      kind: body.kind as PromoRow["kind"],
      planId: body.planId ?? null,
      durationMonths: body.durationMonths ?? null,
      forever: body.forever,
      credits: body.credits ?? null,
      trialDays: body.trialDays ?? null,
      percent: body.percent ?? null,
      amountCents: body.amountCents ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      // Un code d'un lot ne sert qu'une fois.
      maxUses: batch ? 1 : (body.maxUses ?? null),
      onePerAccount: body.onePerAccount,
      newCustomersOnly: body.newCustomersOnly,
      requiredPlanId: body.requiredPlanId ?? null,
      sort: batch ? ("unique" as const) : body.sort,
      batch,
      note: body.note ?? null,
    })),
  );
  return codes;
}

export function toPromoCode(row: PromoRow): PromoCode {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    planId: row.planId,
    durationMonths: row.durationMonths,
    forever: row.forever,
    credits: row.credits,
    trialDays: row.trialDays,
    percent: row.percent,
    amountCents: row.amountCents,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxUses: row.maxUses,
    usesCount: row.usesCount,
    sort: row.sort,
    batch: row.batch,
    note: row.note,
    disabled: row.disabledAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}
