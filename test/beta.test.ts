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
  it("une demande est gardée une seule fois, puis le code envoyé ouvre un compte", async () => {
    const first = await t.call("POST", "/beta-requests", { body: { email: "Lea@Exemple.org" } });
    expect(first.status).toBe(200);
    await t.call("POST", "/beta-requests", { body: { email: "lea@exemple.org" } });

    const { json } = await t.call<{ requests: BetaRequest[] }>("GET", "/admin/beta-requests", {
      admin: true,
    });
    const mine = json.requests.filter((request) => request.email === "lea@exemple.org");
    expect(mine).toHaveLength(1);

    const invite = await t.call<{ code: string }>("POST", `/admin/beta-requests/${mine[0]?.id}/invite`, {
      admin: true,
    });
    expect(invite.json.code).toMatch(/^BETA-/);
    const mail = t.mailer.sent.findLast((sent) => sent.to === "lea@exemple.org");
    expect(mail?.text).toContain(invite.json.code);

    const again = await t.call("POST", `/admin/beta-requests/${mine[0]?.id}/invite`, { admin: true });
    expect(again.status).toBe(409);

    const code = await t.call("POST", "/auth/code", {
      body: { email: "lea@exemple.org", invitationCode: invite.json.code },
    });
    expect(code.status).toBe(200);
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
