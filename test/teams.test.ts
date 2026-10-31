import type { Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.stop());

async function createTeam(token: string, name: string) {
  return (await t.call<{ team: Team }>("POST", "/teams", { token, body: { name } })).json.team;
}

async function invite(token: string, teamId: string) {
  return (await t.call<{ code: string }>("POST", `/teams/${teamId}/invitations`, { token })).json.code;
}

describe("équipes", () => {
  it("le créateur devient chef et peut inviter ; l'invité rejoint l'équipe", async () => {
    const chef = await t.signUp("chef1@exemple.org", "Dominique");
    const team = await createTeam(chef.token, "Projet tutoré");
    expect(team).toMatchObject({ name: "Projet tutoré", myRole: "chef" });

    const code = await invite(chef.token, team.id);
    expect(code).toMatch(/^EQP-/);

    // Un nouveau compte peut s'inscrire directement avec le code de l'équipe.
    const ali = await t.signUp("ali1@exemple.org", "Ali", code);
    const workspace = await t.workspace(ali.token);
    expect(workspace.teams).toHaveLength(1);
    expect(workspace.teams[0]).toMatchObject({ id: team.id, myRole: "membre" });
    expect(workspace.teams[0]?.members.map((m) => m.displayName)).toEqual(["Ali", "Dominique"]);

    // Un compte existant rejoint avec le même code, mais une seule fois.
    const fatou = await t.signUp("fatou1@exemple.org", "Fatou");
    expect((await t.call("POST", "/invitations/accept", { token: fatou.token, body: { code } })).status).toBe(
      200,
    );
    const again = await t.call("POST", "/invitations/accept", { token: fatou.token, body: { code } });
    expect(again.json).toMatchObject({ error: { code: "already_member" } });
  });

  it("seul le chef invite et retire des membres", async () => {
    const chef = await t.signUp("chef2@exemple.org", "Chef");
    const team = await createTeam(chef.token, "Équipe 2");
    const membre = await t.signUp("membre2@exemple.org", "Membre", await invite(chef.token, team.id));

    expect((await t.call("POST", `/teams/${team.id}/invitations`, { token: membre.token })).status).toBe(403);
    expect(
      (await t.call("DELETE", `/teams/${team.id}/members/${chef.userId}`, { token: membre.token })).status,
    ).toBe(403);

    expect(
      (await t.call("DELETE", `/teams/${team.id}/members/${membre.userId}`, { token: chef.token })).status,
    ).toBe(204);
    expect((await t.workspace(membre.token)).teams).toHaveLength(0);
  });

  it("le chef transmet son rôle avant de pouvoir partir", async () => {
    const chef = await t.signUp("chef3@exemple.org", "Chef");
    const team = await createTeam(chef.token, "Équipe 3");
    const awa = await t.signUp("awa3@exemple.org", "Awa", await invite(chef.token, team.id));

    const leave = await t.call("POST", `/teams/${team.id}/leave`, { token: chef.token });
    expect(leave.json).toMatchObject({ error: { code: "chef_must_transfer" } });

    await t.call("POST", `/teams/${team.id}/transfer`, { token: chef.token, body: { userId: awa.userId } });
    expect((await t.workspace(awa.token)).teams[0]?.myRole).toBe("chef");
    expect((await t.call("POST", `/teams/${team.id}/leave`, { token: chef.token })).status).toBe(204);
  });

  it("une équipe dont on n'est pas membre est introuvable", async () => {
    const chef = await t.signUp("chef4@exemple.org", "Chef");
    const team = await createTeam(chef.token, "Secrète");
    const intrus = await t.signUp("intrus4@exemple.org", "Intrus");
    const response = await t.call("POST", `/teams/${team.id}/projects`, {
      token: intrus.token,
      body: { name: "x" },
    });
    expect(response.status).toBe(404);
  });
});

describe("projets", () => {
  it("tout membre crée et renomme ; seul le chef archive", async () => {
    const chef = await t.signUp("chef5@exemple.org", "Chef");
    const team = await createTeam(chef.token, "Équipe 5");
    const membre = await t.signUp("membre5@exemple.org", "Membre", await invite(chef.token, team.id));

    const created = await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: membre.token,
      body: { name: "Site vitrine" },
    });
    const projectId = created.json.project.id;
    await t.call("PATCH", `/projects/${projectId}`, { token: membre.token, body: { name: "Site" } });
    expect((await t.workspace(chef.token)).teams[0]?.projects).toEqual([
      { id: projectId, teamId: team.id, name: "Site" },
    ]);

    expect(
      (await t.call("PATCH", `/projects/${projectId}`, { token: membre.token, body: { archived: true } }))
        .status,
    ).toBe(403);
    await t.call("PATCH", `/projects/${projectId}`, { token: chef.token, body: { archived: true } });
    expect((await t.workspace(chef.token)).teams[0]?.projects).toEqual([]);
  });
});
