import type { Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
let projectId: string;
let userId: string;

beforeAll(async () => {
  t = await startApp();
  const chef = await t.signUp("chef-stats@exemple.org", "Dominique");
  userId = chef.userId;
  const team = (
    await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Stats" } })
  ).json.team;
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "Rapport" },
    })
  ).json.project.id;
  for (const body of ["Bonjour", "On commence ?"]) {
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { body, mentions: [] },
    });
  }
});
afterAll(() => t.stop());

interface Statistics {
  days: number;
  current: { newUsers: number; messages: number; activeMembers: number };
  timeline: { date: string; members: number; newUsers: number }[];
  heatmap: { weekday: number; hour: number; value: number }[];
  topTeams: { name: string; messages: number }[];
}

describe("statistiques et journal", () => {
  it("compte l'activité de la période, jour par jour et heure par heure", async () => {
    const { json, status } = await t.call<Statistics>("GET", "/admin/statistics?days=7&tz=Africa/Douala", {
      admin: true,
    });
    expect(status).toBe(200);
    expect(json.days).toBe(7);
    expect(json.timeline).toHaveLength(7);
    expect(json.current).toMatchObject({ newUsers: 1, activeMembers: 1 });
    expect(json.current.messages).toBeGreaterThanOrEqual(2);
    const today = json.timeline.at(-1);
    expect(today?.members).toBe(2);
    expect(today?.newUsers).toBe(1);
    expect(json.heatmap.reduce((total, cell) => total + cell.value, 0)).toBe(2);
    expect(json.topTeams).toMatchObject([{ name: "Stats", messages: json.current.messages }]);

    expect((await t.call("GET", "/admin/statistics?days=12", { admin: true })).status).toBe(400);
    const fallback = await t.call<{ timeZone: string }>("GET", "/admin/statistics?tz=Nulle/Part", {
      admin: true,
    });
    expect(fallback.json.timeZone).toBe("UTC");
  });

  it("garde au journal les modifications réussies, pas les lectures ni les refus", async () => {
    await t.call("PATCH", `/admin/users/${userId}`, { admin: true, body: { suspended: true } });
    await t.call("PATCH", `/admin/users/${userId}`, { admin: true, body: { suspended: false } });
    await t.call("PATCH", `/admin/users/${userId}`, { admin: true, body: { suspended: "oui" } });
    await t.call("POST", "/admin-auth/login", { body: { email: "personne@exemple.org", password: "faux" } });

    const { json } = await t.call<{
      entries: { actor: string; action: string; targetId: string | null; detail: string | null }[];
    }>("GET", "/admin/audit", { admin: true });
    const modified = json.entries.filter((entry) => entry.action === "Utilisateur modifié");
    expect(modified).toHaveLength(2);
    expect(modified[0]).toMatchObject({
      actor: "Jeton du serveur",
      targetId: userId,
      detail: "suspended : false",
    });
    expect(json.entries.some((entry) => entry.action === "Connexion refusée")).toBe(true);
    expect(json.entries.some((entry) => entry.detail?.includes("faux"))).toBe(false);

    const actions = await t.call<{ actions: { action: string; value: number }[] }>(
      "GET",
      "/admin/audit/actions",
      {
        admin: true,
      },
    );
    expect(actions.json.actions).toContainEqual({ action: "Utilisateur modifié", value: 2 });
  });
});
