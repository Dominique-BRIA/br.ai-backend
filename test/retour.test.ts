import type { CatchUpResponse, LocalMemory, Message, NotificationsResponse, Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChain } from "../src/ai/client.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ai = new ScriptedAi();
const chain = parseChain("gemini:faux-modele", { gemini: "cle" });

let t: TestApp;
let chef: { token: string; userId: string };
let ali: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  t = await startApp({ ai, serveurChain: chain });
  chef = await t.signUp("chef-retour@exemple.org", "Dominique");
  const team = (
    await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Retour" } })
  ).json.team;
  const code = (
    await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })
  ).json.code;
  ali = await t.signUp("ali-retour@exemple.org", "Ali", code);
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "Rapport" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

const quiet = { category: "discussion", reply: null, memory: [] };

async function say(token: string, body: string, mentions: string[] = []) {
  const { json } = await t.call<{ message: Message }>("POST", `/projects/${projectId}/messages`, {
    token,
    body: { body, mentions },
  });
  await t.serveur?.idle();
  return json.message;
}

describe("préférences de travail", () => {
  it("le serveur envoie la préférence aux machines de son auteur", async () => {
    const machine = await t.live(ali.token);
    await machine.next("welcome");
    ai.replies.push({ ...quiet, preference: "Ali fait ses push lui-même." });
    const message = await say(ali.token, "Pour info, je fais mes push moi-même.");
    const event = await machine.next("preference.noted");
    expect(event).toMatchObject({ text: "Ali fait ses push lui-même.", projectId, messageId: message.id });
    machine.socket.close();
  });

  it("la mémoire locale est sauvegardée et relue", async () => {
    const empty = await t.call<LocalMemory>("GET", "/me/local-memory", { token: ali.token });
    expect(empty.json).toEqual({ content: "", updatedAt: null });
    const content = "# Mémoire\n\n- Ali fait ses push lui-même.\n";
    await t.call("PUT", "/me/local-memory", { token: ali.token, body: { content } });
    const saved = await t.call<LocalMemory>("GET", "/me/local-memory", { token: ali.token });
    expect(saved.json.content).toBe(content);
    // Chacun n'a accès qu'à la sienne.
    expect((await t.call<LocalMemory>("GET", "/me/local-memory", { token: chef.token })).json.content).toBe(
      "",
    );
  });
});

describe("notifications", () => {
  it("liste les mentions et les réponses de l'IA, sans les messages du membre lui-même", async () => {
    ai.replies.push(quiet);
    await say(chef.token, "@Ali peux-tu relire l'introduction ?", [ali.userId]);
    ai.replies.push({ ...quiet, category: "question", reply: "Voici le point demandé." });
    await say(ali.token, "@bria où en est le rapport ?");

    const { json } = await t.call<NotificationsResponse>("GET", "/me/notifications", { token: ali.token });
    expect(json.notifications.map((item) => [item.kind, item.author, item.text])).toEqual([
      ["reply", "serveur", "Voici le point demandé."],
      ["mention", "Dominique", "@Ali peux-tu relire l'introduction ?"],
    ]);
    expect(json.notifications[0]).toMatchObject({ projectName: "Rapport", teamName: "Retour" });

    const forChef = await t.call<NotificationsResponse>("GET", "/me/notifications", { token: chef.token });
    expect(forChef.json.notifications).toEqual([]);
  });
});

describe("résumé d'absence", () => {
  it("ne résume pas quand il y a trop peu de messages", async () => {
    const since = new Date().toISOString();
    ai.replies.push(quiet);
    await say(ali.token, "Je commence la conclusion.");
    const { json } = await t.call<CatchUpResponse>("POST", `/projects/${projectId}/catch-up`, {
      token: chef.token,
      body: { since },
    });
    expect(json).toEqual({ count: 1, summary: null });
  });

  it("résume les messages des autres depuis le départ du membre", async () => {
    const since = new Date().toISOString();
    for (const text of ["Conclusion écrite.", "J'ai ajouté la bibliographie.", "Dominique, tu valides ?"]) {
      ai.replies.push(quiet);
      await say(ali.token, text);
    }
    ai.replies.push(quiet);
    await say(chef.token, "Mon propre message ne compte pas.");

    ai.replies.push("- Ali a terminé la conclusion et attend ta validation.");
    const { json } = await t.call<CatchUpResponse>("POST", `/projects/${projectId}/catch-up`, {
      token: chef.token,
      body: { since },
    });
    expect(json).toEqual({ count: 3, summary: "- Ali a terminé la conclusion et attend ta validation." });
    const request = ai.requests.at(-1);
    expect(request?.purpose).toBe("absence");
    const transcript = request?.messages.at(-1)?.content ?? "";
    expect(transcript).toContain("Membre qui revient : Dominique");
    expect(transcript).toContain("Dominique, tu valides ?");
    expect(transcript).not.toContain("Mon propre message");
  });
});

describe("retours des testeurs et auteur du message", () => {
  it("enregistre un retour envoyé depuis l'extension", async () => {
    const sent = await t.call("POST", "/feedback", {
      token: ali.token,
      body: { text: "Le bouton Ouvrir ne marchait pas.", projectId, extensionVersion: "0.5.0" },
    });
    expect(sent.status).toBe(201);
    const { feedback } = await import("../src/db/schema.ts");
    const rows = await t.db.select().from(feedback);
    expect(rows).toMatchObject([
      { userId: ali.userId, text: "Le bouton Ouvrir ne marchait pas.", status: "new" },
    ]);
  });

  it("rappelle à l'agent à qui il répond", async () => {
    ai.replies.push(quiet);
    await say(ali.token, "Comment va l'IA ?");
    const context = ai.requests.at(-1)?.messages.at(-1)?.content ?? "";
    expect(context).toContain("tu t'adresses à Ali, l'auteur de ce nouveau message");
  });
});
