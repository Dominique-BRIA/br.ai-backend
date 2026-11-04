import type { Message, Order, Project, Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChain } from "../src/ai/client.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ai = new ScriptedAi();
const chain = parseChain("gemini:faux", { gemini: "cle" });
let t: TestApp;
let ali: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  t = await startApp({ ai, serveurChain: chain, cuisinierChain: chain });
  ali = await t.signUp("ali-cloud@exemple.org", "Ali");
  const team = (await t.call<{ team: Team }>("POST", "/teams", { token: ali.token, body: { name: "É" } }))
    .json.team;
  projectId = (
    await t.call<{ project: Project }>("POST", `/teams/${team.id}/projects`, {
      token: ali.token,
      body: { name: "Notes" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

const order = (runOn: "member" | "cloud", title = "Fiche de révision") =>
  t.call<{ order: Order }>("POST", `/projects/${projectId}/orders`, {
    token: ali.token,
    body: { title, brief: "Écrire une fiche en Markdown.", runOn },
  });

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition non atteinte à temps.");
}

describe("machine cloud", () => {
  it("refuse la connexion par code au compte de service", async () => {
    const answer = await t.call("POST", "/auth/code", { body: { email: "machine-cloud@service.invalid" } });
    expect(answer.status).toBe(403);
  });

  it("refuse une commande cloud tant qu'aucune machine n'est enregistrée", async () => {
    expect((await t.call<{ available: boolean }>("GET", "/cloud", { token: ali.token })).json.available).toBe(
      false,
    );
    expect((await order("cloud")).status).toBe(409);
  });

  it("travaille dans un dossier vide et rend les fichiers en pièces jointes", async () => {
    const created = await t.call<{ token: string }>("POST", "/admin/cloud-machines", {
      admin: true,
      body: { label: "gcp-e2-micro" },
    });
    expect(created.status).toBe(200);
    expect((await t.call<{ available: boolean }>("GET", "/cloud", { token: ali.token })).json.available).toBe(
      true,
    );

    // La machine cloud se présente avec son jeton, comme une extension.
    const live = await t.live(created.json.token);
    await live.next("welcome");
    const listed = await t.call<{ machines: { label: string; online: boolean }[] }>(
      "GET",
      "/admin/cloud-machines",
      { admin: true },
    );
    expect(listed.json.machines).toMatchObject([{ label: "gcp-e2-micro", online: true }]);

    const tools: { tool: string; input: Record<string, unknown> }[] = [];
    let running = true;
    void (async () => {
      while (running) {
        const call = await live.next("tool.call");
        tools.push({ tool: call.tool, input: call.input });
        const output =
          call.tool === "cloud_collect"
            ? JSON.stringify({
                files: [
                  {
                    path: "fiche.md",
                    contentType: "text/markdown",
                    base64: Buffer.from("# Fiche").toString("base64"),
                  },
                ],
                skipped: 0,
              })
            : "Dossier de travail prêt.";
        live.socket.send(JSON.stringify({ type: "tool.result", callId: call.callId, ok: true, output }));
      }
    })();

    ai.turns.push(
      { calls: [{ name: "write_file", input: { path: "fiche.md", content: "# Fiche" } }] },
      { calls: [{ name: "finish", input: { success: true, summary: "La fiche est prête." } }] },
    );
    const placed = await order("cloud");
    expect(placed.json.order.runOn).toBe("cloud");
    const orders = async () =>
      (await t.call<{ orders: Order[] }>("GET", `/projects/${projectId}/orders`, { token: ali.token })).json
        .orders;
    await waitFor(async () => (await orders())[0]?.status === "done");
    await waitFor(async () => tools.some((call) => call.tool === "cloud_cleanup"));
    running = false;

    // Dossier vide (sans dépôt), travail, fichiers rendus, ménage.
    expect(tools.map((call) => call.tool)).toEqual([
      "cloud_prepare",
      "write_file",
      "cloud_collect",
      "cloud_cleanup",
    ]);
    expect(tools[0]?.input).toEqual({ repo: null });
    // Pas de coffre de secrets sur la machine cloud, ni de consignes sur un propriétaire.
    const request = ai.toolRequests.at(-1);
    expect(request?.tools.map((tool) => tool.function.name)).not.toContain("write_env");
    expect(String(request?.messages[1]?.content)).toContain("machine cloud de <br/>");

    const { messages } = (
      await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages`, { token: ali.token })
    ).json;
    const final = messages.find((message) => message.body.includes("terminée"));
    expect(final?.attachments).toMatchObject([{ name: "fiche.md", contentType: "text/markdown", size: 7 }]);
    expect(messages.some((message) => message.body.includes("sur la machine cloud de <br/>"))).toBe(true);
    live.socket.close();
  });

  it("demande l'application GitHub pour un projet avec dépôt", async () => {
    await t.call("PUT", `/projects/${projectId}/repo`, {
      token: ali.token,
      body: { repo: { fullName: "ali/notes", defaultBranch: "main" } },
    });
    const refused = await order("cloud", "Autre fiche");
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "cloud_unavailable" } });
    await t.call("PUT", `/projects/${projectId}/repo`, { token: ali.token, body: { repo: null } });
  });

  it("garde les commandes ordinaires sur les machines des membres", async () => {
    const placed = await order("member", "Commande ordinaire");
    expect(placed.json.order.runOn).toBe("member");
  });
});
