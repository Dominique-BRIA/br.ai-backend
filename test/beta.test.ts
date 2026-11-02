import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.stop());

interface BetaRequest {
  id: string;
  email: string;
  inviteCode: string | null;
}

describe("demandes d'accès à la bêta", () => {
  it("une demande est gardée une seule fois, le code envoyé peut être renvoyé, puis ouvre un compte", async () => {
    const first = await t.call("POST", "/beta-requests", { body: { email: "Lea@Exemple.org" } });
    expect(first.status).toBe(200);
    await t.call("POST", "/beta-requests", { body: { email: "lea@exemple.org" } });

    const { json } = await t.call<{ requests: BetaRequest[] }>("GET", "/admin/beta-requests", {
      admin: true,
    });
    const mine = json.requests.filter((request) => request.email === "lea@exemple.org");
    expect(mine).toHaveLength(1);

    const route = `/admin/beta-requests/${mine[0]?.id}/invite`;
    // Le montant est obligatoire : il se choisit à l'envoi.
    expect((await t.call("POST", route, { admin: true })).status).toBe(400);
    const invite = await t.call<{ code: string }>("POST", route, {
      admin: true,
      body: { credits: 750, months: 2 },
    });
    expect(invite.json.code).toMatch(/^BRIA-/);
    const mail = t.mailer.sent.findLast((sent) => sent.to === "lea@exemple.org");
    expect(mail?.text).toContain(invite.json.code);
    expect(mail?.text).toContain("750 crédits d'IA par mois pendant 2 mois");

    const again = await t.call("POST", route, { admin: true, body: { credits: 750, months: 2 } });
    expect(again.status).toBe(409);

    const sentBefore = t.mailer.sent.length;
    const resent = await t.call<{ code: string }>("POST", `/admin/beta-requests/${mine[0]?.id}/resend`, {
      admin: true,
    });
    expect(resent.json.code).toBe(invite.json.code);
    expect(t.mailer.sent.length).toBe(sentBefore + 1);

    // Le code sert quand une équipe le saisit.
    const lea = await t.signUp("lea@exemple.org", "Léa");
    const team = await t.call<{ team: { id: string } }>("POST", "/teams", {
      token: lea.token,
      body: { name: "Équipe de Léa" },
    });
    await t.call("POST", `/teams/${team.json.team.id}/promo`, {
      token: lea.token,
      body: { code: invite.json.code },
    });
    const list = await t.call<{ requests: (BetaRequest & { joined: boolean })[] }>(
      "GET",
      "/admin/beta-requests",
      {
        admin: true,
      },
    );
    expect(list.json.requests.find((request) => request.email === "lea@exemple.org")?.joined).toBe(true);
    const late = await t.call("POST", `/admin/beta-requests/${mine[0]?.id}/resend`, { admin: true });
    expect(late.status).toBe(409);
  });

  it("refuse une adresse invalide et limite les demandes répétées", async () => {
    expect((await t.call("POST", "/beta-requests", { body: { email: "pas-une-adresse" } })).status).toBe(400);
    const statuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      statuses.push(
        (await t.call("POST", "/beta-requests", { body: { email: `n${index}@exemple.org` } })).status,
      );
    }
    expect(statuses).toContain(429);
  });

  it("la liste est réservée à l'équipe interne", async () => {
    expect((await t.call("GET", "/admin/beta-requests")).status).toBe(401);
  });
});
