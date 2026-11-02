import type { Message, NotificationsResponse, Team, TeamUsage } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiClient, parseChain } from "../src/ai/client.ts";
import { aiCalls } from "../src/db/schema.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ai = new ScriptedAi();
const chain = parseChain("gemini:faux-modele", { gemini: "cle" });

let t: TestApp;
let chef: { token: string; userId: string };
let ali: { token: string; userId: string };
let teamId: string;
let projectId: string;

beforeAll(async () => {
  t = await startApp({ ai, serveurChain: chain, cuisinierChain: chain });
  chef = await t.signUp("chef-credits@exemple.org", "Dominique");
  const team = (
    await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Crédits" } })
  ).json.team;
  teamId = team.id;
  const code = (await t.call<{ code: string }>("POST", `/teams/${teamId}/invitations`, { token: chef.token }))
    .json.code;
  ali = await t.signUp("ali-credits@exemple.org", "Ali", code);
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${teamId}/projects`, {
      token: chef.token,
      body: { name: "Mémoire" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

/** Un vrai client d'IA dont le fournisseur renvoie la consommation de jetons voulue. */
function clientUsing(promptTokens: number, completionTokens: number) {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "Bonjour." } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      }),
    )) as unknown as typeof fetch;
  return new AiClient(t.ctx, fakeFetch);
}

const usage = async (token: string) =>
  (await t.call<TeamUsage>("GET", `/teams/${teamId}/usage`, { token })).json;

describe("crédits et quotas", () => {
  it("compte les crédits de chaque appel selon le barème, pour le membre concerné", async () => {
    await clientUsing(10_000, 2_000).complete(parseChain("gemini:m", { gemini: "x" }), {
      purpose: "serveur",
      teamId,
      projectId,
      userId: ali.userId,
      messages: [{ role: "user", content: "?" }],
    });
    const [call] = await t.db.select().from(aiCalls).where(eq(aiCalls.userId, ali.userId));
    // Barème par défaut : 1 crédit pour 1000 jetons en entrée, 3 en sortie.
    expect(call?.credits).toBe(16);

    const forChef = await usage(chef.token);
    expect(forChef).toMatchObject({ plan: { id: "essai", monthlyCredits: 2000 }, used: 16, quota: 2000 });
    expect(forChef.byMember.find((member) => member.displayName === "Ali")?.credits).toBe(16);
    expect((await usage(ali.token)).byMember).toEqual([]);
  });

  it("prévient le chef à 80 % puis à 100 % du quota, une seule fois", async () => {
    const client = clientUsing(1_600_000, 0);
    const call = () =>
      client.complete(parseChain("gemini:m", { gemini: "x" }), {
        purpose: "serveur",
        teamId,
        projectId,
        userId: ali.userId,
        messages: [{ role: "user", content: "?" }],
      });
    await call();
    await call();
    await call();
    const { notifications } = (
      await t.call<NotificationsResponse>("GET", "/me/notifications", { token: chef.token })
    ).json;
    const alerts = notifications.filter((item) => item.text.includes("crédits du mois"));
    expect(alerts.map((item) => item.text.slice(0, 40))).toEqual([
      "L'équipe a utilisé tous ses crédits du m",
      "L'équipe a utilisé 81 % de ses crédits d",
    ]);
  });

  it("n'appelle plus l'IA quand le quota est atteint et dit pourquoi", async () => {
    await t.call<{ message: Message }>("POST", `/projects/${projectId}/messages`, {
      token: ali.token,
      body: { body: "@bria peux-tu écrire le plan du mémoire ?" },
    });
    await t.serveur?.idle();
    const { messages } = (
      await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages`, { token: chef.token })
    ).json;
    expect(messages.at(-1)?.body).toContain("Crédit insuffisant");
    const orders = await t.call<{ orders: unknown[] }>("GET", `/projects/${projectId}/orders`, {
      token: chef.token,
    });
    expect(orders.json.orders).toEqual([]);
  });

  it("applique les limites de la formule d'essai", async () => {
    await t.call("POST", `/teams/${teamId}/projects`, { token: chef.token, body: { name: "Deuxième" } });
    const third = await t.call("POST", `/teams/${teamId}/projects`, {
      token: chef.token,
      body: { name: "Trop" },
    });
    expect(third.json).toMatchObject({ error: { code: "plan_limit" } });
  });
});
