import type { MemoryResponse, Message, Team } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiClient, type ChatMessage, parseChain } from "../src/ai/client.ts";
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
  t = await startApp({ ai, serveurChain: chain });
  chef = await t.signUp("chef@exemple.org", "Dominique");
  const team = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "É" } }))
    .json.team;
  teamId = team.id;
  const code = (
    await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })
  ).json.code;
  ali = await t.signUp("ali@exemple.org", "Ali", code);
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "Site" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

async function say(token: string, body: string) {
  const { json } = await t.call<{ message: Message }>("POST", `/projects/${projectId}/messages`, {
    token,
    body: { body },
  });
  await t.serveur?.idle();
  return json.message;
}

const memory = async () =>
  (await t.call<MemoryResponse>("GET", `/projects/${projectId}/memory`, { token: chef.token })).json.items;
const history = async () =>
  (await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages`, { token: chef.token }))
    .json.messages;

describe("agent serveur", () => {
  it("se tait entre collègues mais note la décision", async () => {
    ai.replies.push({
      category: "decision",
      reply: null,
      memory: [{ op: "add", type: "decision", text: "La base de données sera PostgreSQL." }],
    });
    const message = await say(ali.token, "OK, on part sur PostgreSQL alors.");

    const items = await memory();
    expect(items).toMatchObject([
      {
        type: "decision",
        status: "open",
        text: "La base de données sera PostgreSQL.",
        sourceMessageId: message.id,
        proposedBy: { kind: "member", displayName: "Ali" },
      },
    ]);
    expect((await history()).filter((m) => m.author.kind === "serveur")).toHaveLength(0);

    // Le contexte envoyé à l'IA contient l'équipe, le chef et le message.
    const context = ai.requests.at(-1)?.messages.at(-1)?.content ?? "";
    expect(context).toContain("Dominique (chef d'équipe)");
    expect(context).toContain("OK, on part sur PostgreSQL alors.");
  });

  it("répond quand on l'appelle avec @bria, en réponse au message", async () => {
    ai.replies.push({
      category: "question",
      reply: "Vous avez décidé d'utiliser **PostgreSQL**.",
      memory: [],
    });
    const question = await say(chef.token, "@bria qu'a-t-on décidé pour la base ?");

    const reply = (await history()).at(-1);
    expect(reply).toMatchObject({
      author: { kind: "serveur" },
      body: "Vous avez décidé d'utiliser **PostgreSQL**.",
      replyTo: { id: question.id },
    });
  });

  it("refuse une réponse sans texte quand on l'a appelé, et s'excuse si aucune IA ne répond", async () => {
    ai.replies.push({ category: "question", reply: null, memory: [] });
    await say(ali.token, "@bria tu es là ?");
    expect((await history()).at(-1)).toMatchObject({
      author: { kind: "serveur" },
      body: expect.stringContaining("aucune IA n'est disponible"),
    });

    // Sans mention, une panne reste silencieuse.
    ai.replies.push("indisponible");
    const before = (await history()).length;
    await say(ali.token, "Je regarde ça demain.");
    expect((await history()).length).toBe(before + 1);
  });

  it("propose un compromis puis le transforme en décision", async () => {
    ai.replies.push({
      category: "contradiction",
      reply:
        "Cela contredit la décision prise. Compromis : PostgreSQL en production, SQLite pour les tests ?",
      memory: [{ op: "add", type: "compromise", text: "PostgreSQL en production, SQLite pour les tests." }],
    });
    await say(chef.token, "Finalement je préfère SQLite.");
    const compromise = (await memory()).find((item) => item.type === "compromise");
    expect(compromise).toMatchObject({ status: "open", proposedBy: { kind: "serveur" } });

    // Les références M1, M2… données à l'IA désignent les éléments ouverts.
    const context = ai.requests.at(-1)?.messages.at(-1)?.content ?? "";
    expect(context).toContain("M1 [decision] La base de données sera PostgreSQL.");

    ai.replies.push({
      category: "decision",
      reply: null,
      memory: [
        { op: "resolve", ref: "M2" },
        { op: "add", type: "decision", text: "PostgreSQL en production, SQLite pour les tests." },
      ],
    });
    await say(ali.token, "D'accord avec le compromis.");
    const items = await memory();
    expect(items.find((item) => item.id === compromise?.id)?.status).toBe("resolved");
    expect(items.filter((item) => item.type === "decision")).toHaveLength(2);
  });

  it("ne laisse que le chef stopper une décision, et l'annonce dans le chat", async () => {
    const decision = (await memory()).find((item) => item.type === "decision");

    const refused = await t.call("PATCH", `/memory/${decision?.id}`, {
      token: ali.token,
      body: { status: "stopped" },
    });
    expect(refused.status).toBe(403);

    const stopped = await t.call("PATCH", `/memory/${decision?.id}`, {
      token: chef.token,
      body: { status: "stopped" },
    });
    expect(stopped.status).toBe(200);
    expect((await history()).at(-1)).toMatchObject({
      author: { kind: "serveur" },
      body: expect.stringContaining("Dominique (chef d'équipe) a stoppé la décision"),
    });
  });

  it("une IA qui ne demande pas l'arrêt (via resolve) ne peut pas stopper pour un membre", async () => {
    const open = (await memory()).filter((item) => item.status === "open");
    const index = open.findIndex((item) => item.type === "decision");
    ai.replies.push({
      category: "decision",
      reply: null,
      memory: [{ op: "resolve", ref: `M${index + 1}`, status: "stopped" }],
    });
    await say(ali.token, "On annule cette décision.");
    expect((await memory()).find((item) => item.id === open[index]?.id)?.status).toBe("resolved");
  });
});

describe("notes ajoutées à la main", () => {
  it("un membre ajoute une note à la mémoire du projet", async () => {
    const created = await t.call<{ item: { type: string; text: string; proposedBy: { kind: string } } }>(
      "POST",
      `/projects/${projectId}/memory`,
      { token: ali.token, body: { type: "question", text: "Quel hébergeur pour la bêta ?" } },
    );
    expect(created.status).toBe(200);
    expect(created.json.item).toMatchObject({ type: "question", proposedBy: { kind: "member" } });
    expect((await memory()).some((item) => item.text === "Quel hébergeur pour la bêta ?")).toBe(true);
  });

  it("indique la dernière activité de chaque membre", async () => {
    const team = (await t.workspace(chef.token)).teams[0];
    expect(team?.members.every((member) => typeof member.lastSeenAt === "string")).toBe(true);
  });
});

describe("couche commune d'IA", () => {
  it("réessaie une limite de débit, passe au modèle suivant en cas d'échec ou de réponse inexploitable, et journalise chaque appel", async () => {
    const answers = [
      new Response("quota", { status: 429 }),
      new Response("quota", { status: 429 }),
      new Response(JSON.stringify({ choices: [{ message: { content: "pas du JSON" } }] })),
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok": true}' } }],
          usage: { prompt_tokens: 120, completion_tokens: 8 },
        }),
      ),
    ];
    const calledModels: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calledModels.push(JSON.parse(String(init.body)).model);
      return answers.shift() as Response;
    }) as typeof fetch;
    const client = new AiClient(t.ctx, fakeFetch);
    const result = await client.complete(parseChain("gemini:a,groq:b,gemini:c", { gemini: "x", groq: "y" }), {
      purpose: "essai",
      teamId,
      messages: [{ role: "user", content: "?" }],
      json: true,
      accept: (content) => {
        try {
          JSON.parse(content);
          return true;
        } catch {
          return false;
        }
      },
    });

    // Une limite de débit est réessayée une fois sur le même modèle avant de passer au suivant.
    expect(calledModels).toEqual(["a", "a", "b", "c"]);
    expect(result).toEqual({ content: '{"ok": true}', provider: "gemini", model: "c" });
    const calls = await t.db.select().from(aiCalls).where(eq(aiCalls.purpose, "essai"));
    expect(calls.map((call) => [call.model, call.ok])).toEqual([
      ["a", false],
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
    expect(calls.at(-1)).toMatchObject({ inputTokens: 120, outputTokens: 8 });
  });

  it("envoie à Mistral un historique sans les champs propres à Gemini, avec des identifiants à 9 caractères", async () => {
    const bodies: { model: string; messages: ChatMessage[] }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Fini." } }] }));
    }) as typeof fetch;
    const client = new AiClient(t.ctx, fakeFetch);
    const geminiCall = {
      id: "function-call-1234567890",
      type: "function" as const,
      function: { name: "read_file", arguments: '{"path":"a.txt"}' },
      extra_content: { google: { thought_signature: "signature" } },
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "Lis a.txt" },
      { role: "assistant", content: null, tool_calls: [geminiCall] },
      { role: "tool", tool_call_id: geminiCall.id, name: "read_file", content: "bonjour" },
    ];
    const tools = [
      { type: "function" as const, function: { name: "read_file", description: "Lit", parameters: {} } },
    ];
    await client.toolTurn(parseChain("mistral:m", { mistral: "x" }), {
      purpose: "essai-outils",
      messages,
      tools,
    });
    await client.toolTurn(parseChain("gemini:g", { gemini: "x" }), {
      purpose: "essai-outils",
      messages,
      tools,
    });

    const [toMistral, toGemini] = bodies;
    if (!toMistral) throw new Error("Aucun appel à Mistral.");
    const sent = toMistral.messages[1] as unknown as { tool_calls: Record<string, unknown>[] };
    expect(sent.tool_calls[0]).not.toHaveProperty("extra_content");
    expect(sent.tool_calls[0]?.id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect((toMistral.messages[2] as { tool_call_id: string }).tool_call_id).toBe(sent.tool_calls[0]?.id);
    // Gemini retrouve sa signature telle quelle.
    expect(toGemini?.messages[1]).toEqual(messages[1]);
  });

  it("laisse de côté un modèle au quota épuisé, le temps indiqué par le fournisseur", async () => {
    const quota = JSON.stringify([{ error: { code: 429, details: [{ retryDelay: "30s" }] } }]);
    const calledModels: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(String(init.body));
      calledModels.push(model);
      return model === "a"
        ? new Response(quota, { status: 429 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "Fini." } }] }));
    }) as typeof fetch;
    const client = new AiClient(t.ctx, fakeFetch);
    const chain = parseChain("gemini:a,groq:b", { gemini: "x", groq: "y" });
    const turn = { purpose: "essai-pause", messages: [{ role: "user" as const, content: "?" }], tools: [] };
    await client.toolTurn(chain, turn);
    await client.toolTurn(chain, turn);
    // Deux refus sur « a » (essai et nouvel essai), puis « b » ; au tour suivant, « a » est sauté.
    expect(calledModels).toEqual(["a", "a", "b", "b"]);
  });

  it("ignore les fournisseurs sans clé", () => {
    expect(parseChain("gemini:a, groq:b, inconnu:c", { gemini: "x" }).map((choice) => choice.model)).toEqual([
      "a",
    ]);
  });
});
