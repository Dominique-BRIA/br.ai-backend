import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_PERMISSIONS } from "../src/auth/adminPermissions.ts";
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
const withSession = (
  url: string,
  session: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  payload?: Record<string, unknown>,
) => t.app.inject({ method, url, headers: { "x-admin-session": session }, payload });

const adminId = async (email: string) => {
  const { json } = await t.call<{ admins: { id: string; email: string }[] }>("GET", "/admin/admins", {
    admin: true,
  });
  return json.admins.find((admin) => admin.email === email)?.id;
};

describe("comptes de l'équipe interne", () => {
  it("crée un compte avec le jeton d'administration, et exige un mot de passe solide", async () => {
    const weak = await t.call("POST", "/admin/admins", {
      admin: true,
      body: { email: "dominique@exemple.org", name: "Dominique", password: "court" },
    });
    expect(weak.status).toBe(400);
    const created = await t.call("POST", "/admin/admins", {
      admin: true,
      body: {
        email: "Dominique@Exemple.org",
        name: "Dominique",
        password: "un mot de passe solide",
        permissions: ADMIN_PERMISSIONS,
      },
    });
    expect(created.status).toBe(201);
    const list = await t.call<{ admins: { email: string; passwordHash?: string }[] }>(
      "GET",
      "/admin/admins",
      { admin: true },
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
    expect((await withSession("/admin-auth/me", json.token)).json()).toMatchObject({
      admin: { email: "dominique@exemple.org", name: "Dominique", permissions: [...ADMIN_PERMISSIONS] },
    });

    await withSession("/admin-auth/logout", json.token, "POST");
    expect((await withSession("/admin/overview", json.token)).statusCode).toBe(401);
  });

  it("change son mot de passe et ferme ses autres sessions", async () => {
    const other = (await login("dominique@exemple.org", "un mot de passe solide")).json.token;
    const current = (await login("dominique@exemple.org", "un mot de passe solide")).json.token;
    const change = (currentPassword: string, newPassword: string) =>
      withSession("/admin-auth/password", current, "POST", { currentPassword, newPassword });

    expect((await change("faux", "nouveau mot de passe solide")).statusCode).toBe(403);
    expect((await change("un mot de passe solide", "court")).statusCode).toBe(400);
    expect((await change("un mot de passe solide", "nouveau mot de passe solide")).statusCode).toBe(200);
    expect((await withSession("/admin/overview", other)).statusCode).toBe(401);
    expect((await withSession("/admin/overview", current)).statusCode).toBe(200);
    expect((await login("dominique@exemple.org", "nouveau mot de passe solide")).status).toBe(200);

    expect((await change("nouveau mot de passe solide", "un mot de passe solide")).statusCode).toBe(200);
  });

  it("modifie son profil ; changer d'adresse demande le mot de passe", async () => {
    const session = (await login("dominique@exemple.org", "un mot de passe solide")).json.token;
    expect((await withSession("/admin-auth/me", session, "PATCH", { name: "Dominique B." })).statusCode).toBe(
      200,
    );
    const noPassword = await withSession("/admin-auth/me", session, "PATCH", { email: "d@exemple.org" });
    expect(noPassword.statusCode).toBe(403);
    const moved = await withSession("/admin-auth/me", session, "PATCH", {
      email: "d@exemple.org",
      currentPassword: "un mot de passe solide",
    });
    expect(moved.json()).toEqual({ admin: { email: "d@exemple.org", name: "Dominique B." } });
    await withSession("/admin-auth/me", session, "PATCH", {
      name: "Dominique",
      email: "dominique@exemple.org",
      currentPassword: "un mot de passe solide",
    });
  });

  it("limite un compte aux sections autorisées, en entier ou en lecture seule", async () => {
    await t.call("POST", "/admin/admins", {
      admin: true,
      body: {
        email: "awa@exemple.org",
        name: "Awa",
        password: "le mot de passe d'Awa",
        permissions: ["retours"],
      },
    });
    const awa = (await login("awa@exemple.org", "le mot de passe d'Awa")).json.token;
    expect((await withSession("/admin/overview", awa)).statusCode).toBe(200);
    expect((await withSession("/admin/feedback", awa)).statusCode).toBe(200);
    expect((await withSession("/admin/users", awa)).statusCode).toBe(403);
    expect((await withSession("/admin/admins", awa)).statusCode).toBe(403);

    const dominique = (await login("dominique@exemple.org", "un mot de passe solide")).json.token;
    const awaId = await adminId("awa@exemple.org");
    const granted = await withSession(`/admin/admins/${awaId}`, dominique, "PATCH", {
      permissions: ["retours", "utilisateurs"],
    });
    expect(granted.statusCode).toBe(200);
    expect((await withSession("/admin/users", awa)).statusCode).toBe(200);

    // En lecture seule, la section se consulte mais ne se modifie pas.
    await withSession(`/admin/admins/${awaId}`, dominique, "PATCH", {
      permissions: ["utilisateurs:lecture"],
    });
    expect((await withSession("/admin/users", awa)).statusCode).toBe(200);
    // Le contrôle d'accès passe avant la recherche du compte : n'importe quel identifiant convient.
    const blocked = await withSession(`/admin/users/${awaId}`, awa, "PATCH", { suspended: true });
    expect(blocked.statusCode).toBe(403);
    expect((await withSession("/admin/feedback", awa)).statusCode).toBe(403);
    const unknown = await withSession(`/admin/admins/${awaId}`, dominique, "PATCH", {
      permissions: ["utilisateurs:ecriture"],
    });
    expect(unknown.statusCode).toBe(400);

    // Personne ne change ses propres droits, et il reste toujours un compte qui gère les comptes.
    const dominiqueId = await adminId("dominique@exemple.org");
    expect(
      (await withSession(`/admin/admins/${dominiqueId}`, dominique, "PATCH", { permissions: [] })).statusCode,
    ).toBe(409);
    const lastManager = await t.call("PATCH", `/admin/admins/${dominiqueId}`, {
      admin: true,
      body: { permissions: ["retours"] },
    });
    expect(lastManager.status).toBe(409);
  });

  it("refuse un compte désactivé et bloque après trop d'échecs", async () => {
    await t.call("POST", "/admin/admins", {
      admin: true,
      body: { email: "ali@exemple.org", name: "Ali", password: "un autre mot de passe" },
    });
    const ali = await adminId("ali@exemple.org");
    const session = (await login("ali@exemple.org", "un autre mot de passe")).json.token;
    await t.call("PATCH", `/admin/admins/${ali}`, { admin: true, body: { disabled: true } });
    expect((await withSession("/admin/overview", session)).statusCode).toBe(401);
    expect((await login("ali@exemple.org", "un autre mot de passe")).status).toBe(401);

    // Dominique est le seul compte actif qui gère les comptes : il ne peut pas être désactivé.
    const dominique = await adminId("dominique@exemple.org");
    const own = (await login("dominique@exemple.org", "un mot de passe solide")).json.token;
    expect(
      (await withSession(`/admin/admins/${dominique}`, own, "PATCH", { disabled: true })).statusCode,
    ).toBe(409);
    const last = await t.call("PATCH", `/admin/admins/${dominique}`, {
      admin: true,
      body: { disabled: true },
    });
    expect(last.status).toBe(409);

    for (let attempt = 0; attempt < 5; attempt++) await login("dominique@exemple.org", "mauvais");
    const blocked = await login("dominique@exemple.org", "un mot de passe solide");
    expect(blocked.json).toMatchObject({ error: { code: "too_many_attempts" } });
  });
});
