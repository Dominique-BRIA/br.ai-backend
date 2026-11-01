import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.stop());

describe("connexion par e-mail", () => {
  it("refuse de créer un compte sans invitation", async () => {
    const response = await t.call("POST", "/auth/code", { body: { email: "sans@exemple.org" } });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: { code: "invitation_required" } });
  });

  it("refuse une invitation inconnue", async () => {
    const response = await t.call("POST", "/auth/code", {
      body: { email: "faux@exemple.org", invitationCode: "BETA-XXXX-XXXX" },
    });
    expect(response.json).toMatchObject({ error: { code: "invitation_invalid" } });
  });

  it("un envoi qui échoue ne bloque pas une nouvelle demande", async () => {
    const invite = await t.betaInvite(1);
    const body = { email: "envoi@exemple.org", invitationCode: invite };
    t.mailer.failNext = 1;
    expect((await t.call("POST", "/auth/code", { body })).status).toBe(500);
    const again = await t.call("POST", "/auth/code", { body });
    expect(again.status).toBe(200);
    expect(t.mailer.lastCodeFor("envoi@exemple.org")).toMatch(/^\d{6}$/);
  });

  it("crée un compte avec une invitation, puis reconnecte sans invitation", async () => {
    const invite = await t.betaInvite(1);
    const email = "Awa@Exemple.org";

    const first = await t.call("POST", "/auth/code", { body: { email, invitationCode: invite } });
    expect(first.json).toEqual({ newAccount: true });

    const code = t.mailer.lastCodeFor("awa@exemple.org");
    const missingName = await t.call("POST", "/auth/verify", {
      body: { email, code, machineId: "m1" },
    });
    expect(missingName.json).toMatchObject({ error: { code: "display_name_required" } });

    const created = await t.call<{ token: string; user: { email: string; displayName: string } }>(
      "POST",
      "/auth/verify",
      { body: { email, code, machineId: "m1", displayName: "Awa" } },
    );
    expect(created.status).toBe(200);
    expect(created.json.user).toMatchObject({ email: "awa@exemple.org", displayName: "Awa" });

    // L'invitation à usage unique est épuisée.
    const reused = await t.call("POST", "/auth/code", {
      body: { email: "autre@exemple.org", invitationCode: invite },
    });
    expect(reused.json).toMatchObject({ error: { code: "invitation_invalid" } });

    // Le compte existe : plus besoin d'invitation (mais il faut attendre une minute entre deux codes).
    const tooSoon = await t.call("POST", "/auth/code", { body: { email } });
    expect(tooSoon.json).toMatchObject({ error: { code: "too_many_requests" } });
  });

  it("bloque après cinq codes erronés", async () => {
    const invite = await t.betaInvite();
    await t.call("POST", "/auth/code", { body: { email: "essais@exemple.org", invitationCode: invite } });
    const good = t.mailer.lastCodeFor("essais@exemple.org");
    const wrong = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const response = await t.call("POST", "/auth/verify", {
        body: { email: "essais@exemple.org", code: wrong, machineId: "m", displayName: "E" },
      });
      expect(response.json).toMatchObject({ error: { code: "code_invalid" } });
    }
    const blocked = await t.call("POST", "/auth/verify", {
      body: { email: "essais@exemple.org", code: good, machineId: "m", displayName: "E" },
    });
    expect(blocked.json).toMatchObject({ error: { code: "too_many_attempts" } });
  });

  it("exige une session pour l'espace de travail, et la révoque à la déconnexion", async () => {
    expect((await t.call("GET", "/workspace")).status).toBe(401);

    const { token } = await t.signUp("session@exemple.org", "Session");
    expect((await t.call("GET", "/workspace", { token })).status).toBe(200);

    expect((await t.call("POST", "/auth/logout", { token })).status).toBe(204);
    expect((await t.call("GET", "/workspace", { token })).status).toBe(401);
  });

  it("ferme les routes d'administration sans le bon jeton", async () => {
    const response = await t.call("POST", "/admin/beta-invites", { body: {} });
    expect(response.status).toBe(401);
  });
});

describe("e-mail de connexion", () => {
  it("contient le code en texte et dans une version HTML mise en forme", async () => {
    const invite = await t.betaInvite();
    await t.call("POST", "/auth/code", { body: { email: "html@exemple.org", invitationCode: invite } });
    const mail = t.mailer.sent.findLast((candidate) => candidate.to === "html@exemple.org");
    const code = t.mailer.lastCodeFor("html@exemple.org");
    expect(mail?.subject).toBe(`Votre code de connexion <br>.ia : ${code}`);
    expect(mail?.html).toContain(`>${code}</div>`);
    expect(mail?.html).toContain("font-size:44px");
  });
});
