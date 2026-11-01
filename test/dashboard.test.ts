import type { Team, TeamUsage } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
let chef: { token: string; userId: string };
let teamId: string;

beforeAll(async () => {
  t = await startApp();
  chef = await t.signUp("chef-admin@exemple.org", "Dominique");
  teamId = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Tableau" } }))
    .json.team.id;
});
afterAll(() => t.stop());

const admin = <T>(method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: object) =>
  t.call<T>(method, url, { admin: true, ...(body && { body }) });

describe("tableau de bord d'administration", () => {
  it("est fermé sans le jeton d'administration", async () => {
    expect((await t.call("GET", "/admin/overview")).status).toBe(401);
    expect((await t.call("GET", "/admin/overview", { token: chef.token })).status).toBe(401);
  });

  it("donne une vue d'ensemble et cherche les utilisateurs", async () => {
    const { json } = await admin<{ users: number; teams: number; chains: object }>("GET", "/admin/overview");
    expect(json).toMatchObject({ users: 1, teams: 1, chains: { serveur: [], cuisinier: [] } });
    const found = await admin<{ users: { email: string; teams: number }[] }>(
      "GET",
      "/admin/users?search=chef-admin",
    );
    expect(found.json.users).toMatchObject([{ email: "chef-admin@exemple.org", teams: 1 }]);
  });

  it("change la formule d'une équipe, lui accorde des crédits et règle les formules", async () => {
    await admin("PATCH", `/admin/teams/${teamId}`, {
      planId: "equipe",
      planEndsAt: null,
      grantCredits: 1000,
    });
    await admin("PATCH", "/admin/plans/equipe", { monthlyCredits: 30000 });
    const usage = (await t.call<TeamUsage>("GET", `/teams/${teamId}/usage`, { token: chef.token })).json;
    expect(usage).toMatchObject({ plan: { id: "equipe", monthlyCredits: 30000 }, bonus: 1000, quota: 31000 });
    const { json } = await admin<{ teams: { name: string; effectivePlan: string }[] }>("GET", "/admin/teams");
    expect(json.teams).toMatchObject([{ name: "Tableau", effectivePlan: "Équipe" }]);
  });

  it("règle le barème des crédits", async () => {
    const rates = { default: { input: 2, output: 4 }, models: { "gemini:flash": { input: 0.5, output: 1 } } };
    await admin("PUT", "/admin/credit-rates", rates);
    expect((await admin<{ rates: object }>("GET", "/admin/credit-rates")).json.rates).toEqual(rates);
  });

  it("suit les retours des testeurs", async () => {
    await t.call("POST", "/feedback", { token: chef.token, body: { text: "Très bien." } });
    const list = await admin<{ feedback: { id: string; status: string; userName: string }[] }>(
      "GET",
      "/admin/feedback",
    );
    expect(list.json.feedback).toMatchObject([{ status: "new", userName: "Dominique" }]);
    await admin("PATCH", `/admin/feedback/${list.json.feedback[0]?.id}`, { status: "done" });
    const after = await admin<{ feedback: { status: string }[] }>("GET", "/admin/feedback");
    expect(after.json.feedback[0]?.status).toBe("done");
  });

  it("suspend un compte : ses sessions et ses nouvelles connexions sont refusées", async () => {
    await admin("PATCH", `/admin/users/${chef.userId}`, { suspended: true });
    expect((await t.call("GET", "/workspace", { token: chef.token })).status).toBe(401);
    const code = await t.call("POST", "/auth/code", { body: { email: "chef-admin@exemple.org" } });
    expect(code.json).toMatchObject({ error: { code: "account_suspended" } });

    await admin("PATCH", `/admin/users/${chef.userId}`, { suspended: false });
    expect((await t.call("GET", "/workspace", { token: chef.token })).status).toBe(200);
  });
});
