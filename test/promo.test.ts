import type { PromoCode, RedeemPromoResponse, Team, TeamUsage } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
let chef: { token: string; userId: string };
let ali: { token: string; userId: string };
let teamId: string;

beforeAll(async () => {
  t = await startApp();
  chef = await t.signUp("chef-promo@exemple.org", "Dominique");
  teamId = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Promo" } }))
    .json.team.id;
  const code = (await t.call<{ code: string }>("POST", `/teams/${teamId}/invitations`, { token: chef.token }))
    .json.code;
  ali = await t.signUp("ali-promo@exemple.org", "Ali", code);
});
afterAll(() => t.stop());

const create = async (body: object) =>
  (await t.call<{ codes: string[] }>("POST", "/admin/promo-codes", { admin: true, body })).json.codes;
const redeem = (code: string, token = chef.token) =>
  t.call<RedeemPromoResponse>("POST", `/teams/${teamId}/promo`, { token, body: { code } });
const usage = async () =>
  (await t.call<TeamUsage>("GET", `/teams/${teamId}/usage`, { token: chef.token })).json;

describe("codes promotionnels", () => {
  it("offre des crédits en bonus pour le mois", async () => {
    const [code] = await create({ kind: "credits", code: "BONUS-500", credits: 500 });
    const { json } = await redeem(code ?? "");
    expect(json.message).toBe("500 crédits en plus ce mois-ci.");
    expect(await usage()).toMatchObject({ bonus: 500, quota: 2500 });
  });

  it("refuse un second usage par le même compte, et l'usage par un membre", async () => {
    expect((await redeem("BONUS-500")).json).toMatchObject({ error: { code: "promo_already_used" } });
    const [other] = await create({ kind: "credits", credits: 10 });
    expect((await redeem(other ?? "", ali.token)).status).toBe(403);
  });

  it("offre une formule pendant quelques mois, puis la retrouve dans la consommation", async () => {
    const [code] = await create({ kind: "plan", code: "ETUDIANT-3", planId: "etudiant", durationMonths: 3 });
    const { json } = await redeem(code ?? "");
    expect(json.message).toMatch(/^Formule Étudiant jusqu'au /);
    const after = await usage();
    expect(after.plan).toMatchObject({ id: "etudiant", maxMembers: 6, monthlyCredits: 10000 });
    expect(after.planEndsAt).not.toBeNull();
  });

  it("vérifie l'expiration, le nombre d'utilisations et la formule requise", async () => {
    const [expired] = await create({ kind: "credits", credits: 1, expiresAt: "2020-01-01T00:00:00.000Z" });
    expect((await redeem(expired ?? "")).json).toMatchObject({ error: { code: "promo_expired" } });

    const [onlySolo] = await create({ kind: "credits", credits: 1, requiredPlanId: "solo" });
    expect((await redeem(onlySolo ?? "")).json).toMatchObject({ error: { code: "promo_not_eligible" } });

    const [newOnly] = await create({ kind: "credits", credits: 1, newCustomersOnly: true });
    expect((await redeem(newOnly ?? "")).json).toMatchObject({ error: { code: "promo_not_eligible" } });

    expect((await redeem("INCONNU-1")).json).toMatchObject({ error: { code: "promo_invalid" } });
  });

  it("génère un lot de codes uniques, utilisables une fois chacun, et désactivables", async () => {
    const codes = await create({ kind: "trial", planId: "equipe", trialDays: 14, count: 3, prefix: "ESSAI" });
    expect(codes).toHaveLength(3);
    expect(new Set(codes).size).toBe(3);
    expect(codes[0]).toMatch(/^ESSAI-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const { json } = await t.call<{ codes: PromoCode[] }>("GET", "/admin/promo-codes", { admin: true });
    const batch = json.codes.filter((code) => codes.includes(code.code));
    expect(batch.every((code) => code.maxUses === 1 && code.sort === "unique")).toBe(true);

    await t.call("PATCH", `/admin/promo-codes/${batch[0]?.id}`, { admin: true, body: { disabled: true } });
    expect((await redeem(batch[0]?.code ?? "")).json).toMatchObject({ error: { code: "promo_invalid" } });

    const trial = await redeem(batch[1]?.code ?? "");
    expect(trial.json.message).toMatch(/^Essai de la formule Équipe jusqu'au /);
  });

  it("enregistre une réduction pour le jour où le paiement existera", async () => {
    const [code] = await create({ kind: "percent", percent: 20 });
    expect((await redeem(code ?? "")).json.message).toContain("Réduction de 20 % enregistrée");
  });
});
