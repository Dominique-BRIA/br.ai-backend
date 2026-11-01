import { randomBytes } from "node:crypto";
import type {
  NotificationsResponse,
  ProjectSecret,
  SecretLogResponse,
  SecretsResponse,
  SecretValuesResponse,
  Team,
} from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectSecrets } from "../src/db/schema.ts";
import { Vault } from "../src/secrets/vault.ts";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
let chef: { token: string; userId: string };
let ali: { token: string; userId: string };
let fatou: { token: string; userId: string };
let teamId: string;
let projectId: string;

beforeAll(async () => {
  t = await startApp({ vault: new Vault(randomBytes(32).toString("base64")) });
  chef = await t.signUp("chef-coffre@exemple.org", "Dominique");
  const team = (
    await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Coffre" } })
  ).json.team;
  teamId = team.id;
  const invite = async () =>
    (await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })).json
      .code;
  ali = await t.signUp("ali-coffre@exemple.org", "Ali", await invite());
  fatou = await t.signUp("fatou-coffre@exemple.org", "Fatou", await invite());
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "API" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

const create = (name: string, value: string, access: string[], token = chef.token) =>
  t.call<{ secret: ProjectSecret }>("POST", `/projects/${projectId}/secrets`, {
    token,
    body: { name, value, access },
  });
const values = async (token: string) =>
  (await t.call<SecretValuesResponse>("POST", `/projects/${projectId}/secrets/values`, { token })).json
    .values;

describe("coffre de secrets", () => {
  it("chiffre la valeur en base et ne la renvoie qu'aux membres autorisés", async () => {
    expect((await create("DATABASE_URL", "postgres://secret@hote/base", [ali.userId])).status).toBe(200);
    expect((await create("STRIPE_KEY", "sk_test_123", [])).status).toBe(200);

    // En base, la valeur n'apparaît pas en clair.
    const [row] = await t.db.select().from(projectSecrets).where(eq(projectSecrets.name, "DATABASE_URL"));
    expect(row?.ciphertext).not.toContain("postgres");

    expect(await values(ali.token)).toEqual([{ name: "DATABASE_URL", value: "postgres://secret@hote/base" }]);
    expect(await values(fatou.token)).toEqual([]);
    expect((await values(chef.token)).map((entry) => entry.name)).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
  });

  it("montre les noms sans les valeurs, et les accès seulement au chef", async () => {
    const forChef = (
      await t.call<SecretsResponse>("GET", `/projects/${projectId}/secrets`, { token: chef.token })
    ).json;
    expect(forChef.enabled).toBe(true);
    expect(forChef.secrets.map((secret) => [secret.name, secret.access])).toEqual([
      ["DATABASE_URL", [ali.userId]],
      ["STRIPE_KEY", []],
    ]);
    expect(JSON.stringify(forChef)).not.toContain("sk_test_123");

    const forAli = (
      await t.call<SecretsResponse>("GET", `/projects/${projectId}/secrets`, { token: ali.token })
    ).json;
    expect(forAli.secrets.map((secret) => [secret.name, secret.access])).toEqual([["DATABASE_URL", []]]);
  });

  it("réserve la gestion au chef et refuse les noms invalides ou en double", async () => {
    expect((await create("API_TOKEN", "x", [], ali.token)).status).toBe(403);
    expect((await create("api-token", "x", [])).status).toBe(400);
    expect((await create("DATABASE_URL", "x", [])).json).toMatchObject({ error: { code: "secret_exists" } });
  });

  it("change la valeur et les accès, puis note tout dans le journal", async () => {
    const list = (
      await t.call<SecretsResponse>("GET", `/projects/${projectId}/secrets`, { token: chef.token })
    ).json.secrets;
    const stripe = list.find((secret) => secret.name === "STRIPE_KEY");
    await t.call("PATCH", `/secrets/${stripe?.id}`, {
      token: chef.token,
      body: { value: "sk_test_456", access: [fatou.userId] },
    });
    expect(await values(fatou.token)).toEqual([{ name: "STRIPE_KEY", value: "sk_test_456" }]);

    const log = (
      await t.call<SecretLogResponse>("GET", `/projects/${projectId}/secrets/log`, { token: chef.token })
    ).json.entries;
    expect(log[0]).toMatchObject({ secretName: "STRIPE_KEY", action: "read", userName: "Fatou" });
    expect(log.some((entry) => entry.action === "updated" && entry.secretName === "STRIPE_KEY")).toBe(true);
    expect(log.some((entry) => entry.action === "read" && entry.userName === "Ali")).toBe(true);
    expect((await t.call("GET", `/projects/${projectId}/secrets/log`, { token: ali.token })).status).toBe(
      403,
    );
  });

  it("au départ d'un membre, retire ses accès et rappelle au chef de changer ses secrets", async () => {
    await t.call("POST", `/teams/${teamId}/leave`, { token: ali.token });
    const list = (
      await t.call<SecretsResponse>("GET", `/projects/${projectId}/secrets`, { token: chef.token })
    ).json.secrets;
    expect(list.find((secret) => secret.name === "DATABASE_URL")?.access).toEqual([]);

    const { notifications } = (
      await t.call<NotificationsResponse>("GET", "/me/notifications", { token: chef.token })
    ).json;
    expect(notifications[0]).toMatchObject({ kind: "mention", author: "serveur" });
    expect(notifications[0]?.text).toContain("Ali a quitté l'équipe");
    expect(notifications[0]?.text).toContain("`DATABASE_URL`");
    expect(notifications[0]?.text).not.toContain("postgres");
  });
});

describe("coffre fermé", () => {
  it("refuse de déposer un secret sans clé de chiffrement", async () => {
    const closed = await startApp();
    const owner = await closed.signUp("chef-ferme@exemple.org", "Chef");
    const team = (
      await closed.call<{ team: Team }>("POST", "/teams", { token: owner.token, body: { name: "F" } })
    ).json.team;
    const project = (
      await closed.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
        token: owner.token,
        body: { name: "P" },
      })
    ).json.project;
    const response = await closed.call("POST", `/projects/${project.id}/secrets`, {
      token: owner.token,
      body: { name: "A", value: "b" },
    });
    expect(response.json).toMatchObject({ error: { code: "vault_disabled" } });
    const list = await closed.call<SecretsResponse>("GET", `/projects/${project.id}/secrets`, {
      token: owner.token,
    });
    expect(list.json).toEqual({ enabled: false, secrets: [] });
    await closed.stop();
  });
});
