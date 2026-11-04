import type { Message, Order, Project, Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChain } from "../src/ai/client.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const chain = parseChain("gemini:faux", { gemini: "cle" });
let t: TestApp;
afterAll(() => t.stop());
beforeAll(async () => {
  t = await startApp({ ai: new ScriptedAi(), serveurChain: chain, cuisinierChain: chain });
});

async function project(app: TestApp, token: string) {
  const team = (await app.call<{ team: Team }>("POST", "/teams", { token, body: { name: "Équipe" } })).json
    .team;
  return (
    await app.call<{ project: Project }>("POST", `/teams/${team.id}/projects`, {
      token,
      body: { name: "Site" },
    })
  ).json.project;
}

describe("commande passée directement", () => {
  it("crée la commande, l'annonce dans le chat et l'ajoute à la liste", async () => {
    const ali = await t.signUp("ali-cmd@exemple.org", "Ali");
    const { id: projectId } = await project(t, ali.token);
    const created = await t.call<{ order: Order }>("POST", `/projects/${projectId}/orders`, {
      token: ali.token,
      body: { title: "Page *contact*", brief: "Un formulaire avec nom, e-mail et message." },
    });
    expect(created.status).toBe(200);
    expect(created.json.order).toMatchObject({
      title: "Page *contact*",
      status: "pending",
      requestedBy: { kind: "member", userId: ali.userId },
    });

    const { messages } = (
      await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages`, { token: ali.token })
    ).json;
    const announcement = messages.find((message) => message.author.kind === "serveur");
    // Le titre reste du texte : ses caractères Markdown sont retirés de l'annonce.
    expect(announcement?.body).toBe("Ali a passé une commande au cuisinier : **Page contact**.");

    const listed = await t.call<{ orders: Order[] }>("GET", `/projects/${projectId}/orders`, {
      token: ali.token,
    });
    expect(listed.json.orders.map((order) => order.id)).toContain(created.json.order.id);
  });

  it("refuse un titre vide et un projet d'une autre équipe", async () => {
    const lea = await t.signUp("lea-cmd@exemple.org", "Léa");
    const sam = await t.signUp("sam-cmd@exemple.org", "Sam");
    const { id: projectId } = await project(t, lea.token);
    const route = `/projects/${projectId}/orders`;
    expect((await t.call("POST", route, { token: lea.token, body: { title: " ", brief: "x" } })).status).toBe(
      400,
    );
    expect((await t.call("POST", route, { token: sam.token, body: { title: "A", brief: "B" } })).status).toBe(
      404,
    );
  });

  it("refuse la commande quand l'équipe n'a pas de crédit", async () => {
    const poor = await startApp({
      ai: new ScriptedAi(),
      serveurChain: chain,
      cuisinierChain: chain,
      essaiCredits: 0,
    });
    try {
      const noa = await poor.signUp("noa-cmd@exemple.org", "Noa");
      const { id: projectId } = await project(poor, noa.token);
      const refused = await poor.call("POST", `/projects/${projectId}/orders`, {
        token: noa.token,
        body: { title: "Page", brief: "Faire la page." },
      });
      expect(refused.status).toBe(402);
      expect(refused.json).toMatchObject({ error: { code: "credits_insufficient" } });
    } finally {
      await poor.stop();
    }
  });
});
