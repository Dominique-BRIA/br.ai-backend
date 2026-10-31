import type { Message, SessionsResponse, Team, User } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.stop());

/** Ouvre une seconde session (une autre machine) pour un compte existant. */
async function secondMachine(email: string) {
  // Un code a déjà été envoyé il y a moins d'une minute : on efface les codes pour contourner ce délai.
  const { loginCodes } = await import("../src/db/schema.ts");
  await t.db.delete(loginCodes);
  await t.call("POST", "/auth/code", { body: { email } });
  const { json } = await t.call<{ token: string }>("POST", "/auth/verify", {
    body: { email, code: t.mailer.lastCodeFor(email), machineId: "machine-2" },
  });
  return json.token;
}

describe("profil", () => {
  it("change le nom affiché et la langue", async () => {
    const { token } = await t.signUp("profil@exemple.org", "Ancien nom");
    const { json } = await t.call<{ user: User }>("PATCH", "/me", {
      token,
      body: { displayName: "Nouveau nom", locale: "en" },
    });
    expect(json.user).toMatchObject({ displayName: "Nouveau nom", locale: "en" });
    expect((await t.workspace(token)).user.displayName).toBe("Nouveau nom");
  });
});

describe("machines", () => {
  it("liste les machines et en déconnecte une à distance", async () => {
    const first = await t.signUp("machines@exemple.org", "Machines");
    const second = await secondMachine("machines@exemple.org");

    const live = await t.live(second);
    await live.next("welcome");

    const { json } = await t.call<SessionsResponse>("GET", "/me/sessions", { token: first.token });
    expect(json.sessions).toHaveLength(2);
    const other = json.sessions.find((session) => !session.current);
    expect(other).toMatchObject({ online: true, os: "windows", editor: "Visual Studio Code" });

    expect((await t.call("DELETE", `/me/sessions/${other?.id}`, { token: first.token })).status).toBe(204);
    await live.closed;
    expect((await t.call("GET", "/workspace", { token: second })).status).toBe(401);
    expect((await t.call("GET", "/workspace", { token: first.token })).status).toBe(200);
  });
});

describe("suppression du compte", () => {
  it("exige l'adresse exacte et la transmission du rôle de chef", async () => {
    const chef = await t.signUp("chef-sup@exemple.org", "Chef");
    const team = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "É" } }))
      .json.team;
    const code = (
      await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })
    ).json.code;
    const awa = await t.signUp("awa-sup@exemple.org", "Awa", code);

    const wrong = await t.call("DELETE", "/me", {
      token: chef.token,
      body: { confirmEmail: "autre@exemple.org" },
    });
    expect(wrong.status).toBe(400);
    const blocked = await t.call("DELETE", "/me", {
      token: chef.token,
      body: { confirmEmail: "chef-sup@exemple.org" },
    });
    expect(blocked.json).toMatchObject({ error: { code: "chef_must_transfer" } });

    // Awa écrit, puis supprime son compte : son message reste, signé « ancien membre ».
    const project = (
      await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
        token: chef.token,
        body: { name: "P" },
      })
    ).json.project;
    await t.call("POST", `/projects/${project.id}/messages`, {
      token: awa.token,
      body: { body: "Au revoir" },
    });
    expect(
      (await t.call("DELETE", "/me", { token: awa.token, body: { confirmEmail: "awa-sup@exemple.org" } }))
        .status,
    ).toBe(204);

    const history = await t.call<{ messages: Message[] }>("GET", `/projects/${project.id}/messages`, {
      token: chef.token,
    });
    expect(history.json.messages[0]?.author).toEqual({ kind: "former_member" });
    expect((await t.workspace(chef.token)).teams[0]?.members).toHaveLength(1);

    // Seul dans son équipe, le chef peut partir : l'équipe est supprimée avec lui.
    expect(
      (await t.call("DELETE", "/me", { token: chef.token, body: { confirmEmail: "chef-sup@exemple.org" } }))
        .status,
    ).toBe(204);
  });
});
