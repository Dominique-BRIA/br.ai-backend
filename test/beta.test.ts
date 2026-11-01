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

    const invite = await t.call<{ code: string }>("POST", `/admin/beta-requests/${mine[0]?.id}/invite`, {
      admin: true,
    });
    expect(invite.json.code).toMatch(/^BETA-/);
    const mail = t.mailer.sent.findLast((sent) => sent.to === "lea@exemple.org");
    expect(mail?.text).toContain(invite.json.code);

    const again = await t.call("POST", `/admin/beta-requests/${mine[0]?.id}/invite`, { admin: true });
    expect(again.status).toBe(409);

    const sentBefore = t.mailer.sent.length;
    const resent = await t.call<{ code: string }>("POST", `/admin/beta-requests/${mine[0]?.id}/resend`, {
      admin: true,
    });
    expect(resent.json.code).toBe(invite.json.code);
    expect(t.mailer.sent.length).toBe(sentBefore + 1);

    await t.signUp("lea@exemple.org", "Léa", invite.json.code);
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
