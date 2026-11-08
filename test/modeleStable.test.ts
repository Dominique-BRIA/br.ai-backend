import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiClient, parseChain } from "../src/ai/client.ts";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startApp({});
});
afterAll(() => t.stop());

const chain = parseChain("gemini:premier,groq:second", { gemini: "a", groq: "b" });
const request = { purpose: "essai", messages: [], tools: [] };

function client(refused: string[]) {
  const tried: string[] = [];
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    tried.push(model);
    return refused.includes(model)
      ? new Response("{}", { status: 500 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }) as typeof fetch;
  return { ai: new AiClient(t.ctx, fakeFetch), tried };
}

describe("choix du modèle", () => {
  it("garde le modèle qui a répondu au tour précédent", async () => {
    const { ai, tried } = client([]);
    const turn = await ai.toolTurn(chain, { ...request, prefer: { provider: "groq", model: "second" } });
    expect(turn.model).toBe("second");
    expect(tried).toEqual(["second"]);
  });

  it("change de modèle seulement s'il ne répond plus, et dit pourquoi", async () => {
    const { ai, tried } = client(["second"]);
    const turn = await ai.toolTurn(chain, { ...request, prefer: { provider: "groq", model: "second" } });
    expect(turn.model).toBe("premier");
    expect(tried).toEqual(["second", "premier"]);
    expect(turn.skipped).toEqual(["groq/second (500)"]);
  });

  it("commence par le début de la chaîne sans préférence", async () => {
    const { ai, tried } = client([]);
    await ai.toolTurn(chain, request);
    expect(tried).toEqual(["premier"]);
  });
});
