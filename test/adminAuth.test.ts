import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.stop());

const login = (email: string, password: string) =>
  t.call<{ token: string; admin: { email: string; name: string } }>("POST", "/admin-auth/login", {
    body: { email, password },
  });
const withSession = (url: string, session: string, method: "GET" | "POST" = "GET") =>
  t.app.inject({ method, url, headers: { "x-admin-session": session } });

describe("comptes de l'équipe interne", () => {
  it("crée un compte avec le jeton d'administration, et exige un mot de passe solide", async () => {
    const weak = await t.call("POST", "/admin/admins", {
      admin: true,
      body: { email: "dominique@exemple.org", name: "Dominique", password: "court" },
    });
    expect(weak.status).toBe(400);
    const created = await t.call("POST", "/admin/admins", {
      admin: true,
      body: { email: "Dominique@Exemple.org", name: "Dominique", password: "un mot de passe solide" },
    });
    expect(created.status).toBe(201);
    const list = await t.call<{ admins: { email: string; passwordHash?: string }[] }>(
      "GET",
      "/admin/admins",
      {
        admin: true,
      },
    );
    expect(list.json.admins).toMatchObject([{ email: "dominique@exemple.org" }]);
    expect(JSON.stringify(list.json)).not.toContain("scrypt");
  });

  it("ouvre une session par adresse et mot de passe, qui donne accès au tableau de bord", async () => {
    expect((await login("dominique@exemple.org", "faux mot de passe")).status).toBe(401);
    const { json, status } = await login("dominique@exemple.org", "un mot de passe solide");
    expect(status).toBe(200);
    expect(json.admin).toEqual({ email: "dominique@exemple.org", name: "Dominique" });

    expect((await withSession("/admin/overview", json.token)).statusCode).toBe(200);
    expect((await withSession("/admin-auth/me", json.token)).json()).toEqual({
      admin: { email: "dominique@exemple.org", name: "Dominique" },
    });

    await withSession("/admin-auth/logout", json.token, "POST");
    expect((await withSession("/admin/overview", json.token)).statusCode).toBe(401);
  });

  it("refuse un compte désactivé et bloque après trop d'échecs", async () => {
    await t.call("POST", "/admin/admins", {
      admin: true,
      body: { email: "ali@exemple.org", name: "Ali", password: "un autre mot de passe" },
    });
    const { json } = await t.call<{ admins: { id: string; email: string }[] }>("GET", "/admin/admins", {
      admin: true,
    });
    const ali = json.admins.find((admin) => admin.email === "ali@exemple.org");
    const session = (await login("ali@exemple.org", "un autre mot de passe")).json.token;
    await t.call("PATCH", `/admin/admins/${ali?.id}`, { admin: true, body: { disabled: true } });
    expect((await withSession("/admin/overview", session)).statusCode).toBe(401);
    expect((await login("ali@exemple.org", "un autre mot de passe")).status).toBe(401);

    for (let attempt = 0; attempt < 5; attempt++) await login("dominique@exemple.org", "mauvais");
    const blocked = await login("dominique@exemple.org", "un mot de passe solide");
    expect(blocked.json).toMatchObject({ error: { code: "too_many_attempts" } });
  });
});
