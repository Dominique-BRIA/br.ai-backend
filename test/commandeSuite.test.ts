import type { Message, Order, Project, Team } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkCheck } from "../src/agents/workCheck.ts";
import { parseChain } from "../src/ai/client.ts";
import { orders as ordersTable } from "../src/db/schema.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ai = new ScriptedAi();
const chain = parseChain("gemini:faux", { gemini: "cle" });
let t: TestApp;
let ali: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  t = await startApp({ ai, serveurChain: chain, cuisinierChain: chain });
  ali = await t.signUp("ali-suite@exemple.org", "Ali");
  const team = (await t.call<{ team: Team }>("POST", "/teams", { token: ali.token, body: { name: "É" } }))
    .json.team;
  projectId = (
    await t.call<{ project: Project }>("POST", `/teams/${team.id}/projects`, {
      token: ali.token,
      body: { name: "Site" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

const orders = async () =>
  (await t.call<{ orders: Order[] }>("GET", `/projects/${projectId}/orders`, { token: ali.token })).json
    .orders;

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Condition non atteinte à temps : ${JSON.stringify((await orders()).map((o) => o.status))}`,
  );
}

/** Une machine qui a le projet et répond aux outils ; `answer` décide du résultat. */
async function machine(
  answer: (
    tool: string,
    input: Record<string, unknown>,
  ) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>,
) {
  const live = await t.live(ali.token);
  const { connectionId } = await live.next("welcome");
  const tools: string[] = [];
  let running = true;
  void (async () => {
    while (running) {
      const call = await live.next("tool.call");
      if (!running) return;
      tools.push(call.tool);
      live.socket.send(
        JSON.stringify({
          type: "tool.result",
          callId: call.callId,
          ...(await answer(call.tool, call.input)),
        }),
      );
    }
  })();
  live.socket.send(JSON.stringify({ type: "machine.status", projects: [projectId], lending: false }));
  return {
    tools,
    close: async () => {
      running = false;
      live.socket.close();
      await live.closed;
      await waitFor(async () => !t.ctx.hub.byId(connectionId));
    },
  };
}

const place = async (title: string) =>
  (
    await t.call<{ order: Order }>("POST", `/projects/${projectId}/orders`, {
      token: ali.token,
      body: { title, brief: `Réaliser : ${title}.` },
    })
  ).json.order;

const statusOf = async (id: string) => (await orders()).find((order) => order.id === id);
const finished = (id: string) => async () => {
  const status = (await statusOf(id))?.status;
  return status === "done" || status === "failed";
};
const write = (path: string) => ({ calls: [{ name: "write_file", input: { path, content: "x" } }] });
const command = (text: string) => ({ calls: [{ name: "run_command", input: { command: text } }] });
const finish = (summary = "Fait.") => ({ calls: [{ name: "finish", input: { success: true, summary } }] });

describe("vérification du travail", () => {
  it("refuse de terminer tant que le code modifié n'a pas été testé", async () => {
    const order = await place("Script");
    ai.turns.push(
      write("app.js"),
      finish("Trop tôt."),
      command("node app.js"),
      finish("Testé et fonctionnel."),
    );
    const box = await machine(() => ({ ok: true, output: "ok" }));
    await waitFor(finished(order.id));
    await box.close();
    expect(box.tools).toEqual(["write_file", "run_command"]);
    const done = await statusOf(order.id);
    expect(done?.summary).toBe("Testé et fonctionnel.");
    // Le cuisinier a reçu l'explication au lieu de terminer.
    const reminder = ai.toolRequests
      .at(-1)
      ?.messages.find((message) => message.content?.toString().startsWith("Pas encore"));
    expect(reminder?.content).toContain("app.js");
  });

  it("dit dans le bilan ce qui n'a pas pu être vérifié, sans tourner en rond", async () => {
    const order = await place("Script non testé");
    ai.turns.push(write("autre.js"), finish("Un."), finish("Deux."), finish("Fait, sans test possible."));
    const box = await machine(() => ({ ok: true, output: "ok" }));
    await waitFor(finished(order.id));
    await box.close();
    const done = await statusOf(order.id);
    expect(done?.status).toBe("done");
    expect(done?.summary).toContain("Fait, sans test possible.");
    expect(done?.summary).toContain("**Non vérifié**");
    expect(done?.summary).toContain("autre.js");
  });

  it("ne relance pas sans fin une commande qui échoue", async () => {
    const order = await place("Commande en échec");
    ai.turns.push(
      command("npm test"),
      command("npm test"),
      command("npm test"),
      command("npm test"),
      command("npm test"),
      { calls: [{ name: "finish", input: { success: false, summary: "Les tests échouent." } }] },
    );
    const box = await machine((tool) =>
      tool === "run_command" ? { ok: false, output: "échec" } : { ok: true, output: "ok" },
    );
    await waitFor(finished(order.id));
    await box.close();
    // Lancée trois fois seulement : ensuite, le cuisinier est invité à changer d'approche.
    expect(box.tools).toEqual(["run_command", "run_command", "run_command"]);
    expect((await statusOf(order.id))?.status).toBe("failed");
  });

  it("accepte de relire un document, mais pas un script", () => {
    const check = new WorkCheck();
    check.wrote("rapport.md");
    expect(check.beforeFinish()).toContain("rapport.md");
    check.read("rapport.md");
    expect(check.beforeFinish()).toBeNull();

    const code = new WorkCheck();
    code.wrote("app.py");
    code.read("app.py");
    expect(code.note()).toContain("app.py");
    code.command("python app.py", true);
    expect(code.note()).toBe("");
  });
});

describe("suite d'une commande", () => {
  it("reprend la commande terminée au lieu d'en créer une nouvelle", async () => {
    const order = await place("Page d'accueil");
    ai.turns.push(finish("La page existe."));
    const first = await machine(() => ({ ok: true, output: "ok" }));
    await waitFor(finished(order.id));
    await first.close();
    const count = (await orders()).length;

    const answer = await t.call<{ order: Order }>("POST", `/orders/${order.id}/follow-up`, {
      token: ali.token,
      body: { brief: "Ajoute un pied de page." },
    });
    expect(answer.status).toBe(200);
    expect(answer.json.order).toMatchObject({ id: order.id, number: order.number, status: "pending" });

    ai.turns.push(finish("Pied de page ajouté."));
    const second = await machine(() => ({ ok: true, output: "ok" }));
    await waitFor(async () => (await statusOf(order.id))?.summary === "Pied de page ajouté.");
    await second.close();

    expect(await orders()).toHaveLength(count);
    const prompt = String(ai.toolRequests.at(-1)?.messages[1]?.content);
    expect(prompt).toContain("La page existe.");
    expect(prompt).toContain("Ajoute un pied de page.");
    expect(prompt).toContain("ne recommence pas tout");
    const { messages } = (
      await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages?limit=100`, {
        token: ali.token,
      })
    ).json;
    expect(messages.some((message) => message.body.includes("Je reprends la **commande"))).toBe(true);
  });

  it("transmet au cuisinier une suite demandée pendant qu'il travaille", async () => {
    const order = await place("Rapport");
    let sent = false;
    ai.turns.push({ calls: [{ name: "read_file", input: { path: "a.md" } }] }, finish("Rapport et annexe."));
    const box = await machine(async () => {
      if (!sent) {
        sent = true;
        await t.call("POST", `/orders/${order.id}/follow-up`, {
          token: ali.token,
          body: { brief: "Ajoute une annexe." },
        });
      }
      return { ok: true, output: "contenu" };
    });
    await waitFor(finished(order.id));
    await box.close();
    const conversation = ai.toolRequests.at(-1)?.messages ?? [];
    expect(conversation.some((message) => message.content?.toString().includes("Ajoute une annexe."))).toBe(
      true,
    );
    expect((await statusOf(order.id))?.summary).toBe("Rapport et annexe.");
  });

  it("le serveur reconnaît une suite dans le chat", async () => {
    const order = await place("Plan du site");
    ai.turns.push(finish("Plan fait."));
    const box = await machine(() => ({ ok: true, output: "ok" }));
    await waitFor(finished(order.id));
    const count = (await orders()).length;

    ai.replies.push({
      category: "request",
      reply: "Je transmets au cuisinier.",
      memory: [],
      order: { title: "Plan", brief: "Ajoute une page de contact au plan.", continues: order.number },
    });
    ai.turns.push(finish("Contact ajouté."));
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: ali.token,
      body: { body: "@bria ajoute aussi la page de contact au plan" },
    });
    await t.serveur?.idle();
    await waitFor(async () => (await statusOf(order.id))?.summary === "Contact ajouté.");
    await box.close();
    expect(await orders()).toHaveLength(count);
  });

  it("ne promet pas un travail sans passer la commande", async () => {
    const order = await place("Diaporama");
    ai.turns.push(finish("Diaporama fait."));
    const box = await machine(() => ({ ok: true, output: "ok" }));
    await waitFor(finished(order.id));
    const count = (await orders()).length;

    // L'IA annonce le travail sans remplir la commande : elle est relancée, et la suite part.
    ai.replies.push(
      { category: "discussion", reply: "J'ajoute cette mention à la présentation.", memory: [] },
      {
        category: "request",
        reply: "Je transmets au cuisinier.",
        memory: [],
        order: { title: "Diaporama", brief: "Ajouter le nom à la fin.", continues: order.number },
      },
    );
    ai.turns.push(finish("Nom ajouté."));
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: ali.token,
      body: { body: "Ajoute le nom à la fin du diaporama" },
    });
    await t.serveur?.idle();
    await waitFor(async () => (await statusOf(order.id))?.summary === "Nom ajouté.");
    await box.close();
    expect(await orders()).toHaveLength(count);
  });

  it("dit franchement qu'il n'a rien transmis si l'IA persiste à promettre", async () => {
    const before = (await orders()).length;
    ai.replies.push(
      { category: "discussion", reply: "J'ajoute cette mention.", memory: [] },
      { category: "discussion", reply: "J'ajoute cette mention.", memory: [] },
    );
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: ali.token,
      body: { body: "Ajoute une mention" },
    });
    await t.serveur?.idle();
    const { messages } = (
      await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages?limit=100`, {
        token: ali.token,
      })
    ).json;
    expect(messages.at(-1)?.body).toContain("Je n'ai pas réussi à transmettre");
    expect(await orders()).toHaveLength(before);
  });

  it("ne relance pas l'IA quand elle répond sans rien annoncer", async () => {
    const asked = ai.requests.length;
    ai.replies.push({ category: "discussion", reply: "La réunion est à 15 h.", memory: [] });
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: ali.token,
      body: { body: "@bria c'est à quelle heure la réunion ?" },
    });
    await t.serveur?.idle();
    expect(ai.requests.length).toBe(asked + 1);
  });

  it("clôt une commande restée en cours, et range au redémarrage", async () => {
    const stuck = await place("Commande coupée");
    const old = await place("Commande ancienne");
    const recent = await place("Commande récente");
    const set = (id: string, updatedAt: Date) =>
      t.db.update(ordersTable).set({ status: "running", updatedAt }).where(eq(ordersTable.id, id));
    await set(stuck.id, new Date());
    // « Arrêter » fonctionne même si plus aucune machine ne la réalise.
    const stopped = await t.call<{ order: Order }>("POST", `/orders/${stuck.id}/stop`, { token: ali.token });
    expect(stopped.json.order.status).toBe("stopped");

    await set(old.id, new Date(Date.now() - 3 * 86_400_000));
    await set(recent.id, new Date());
    await t.kitchen?.recoverInterrupted();
    expect((await statusOf(old.id))?.status).toBe("stopped");
    expect((await statusOf(recent.id))?.status).toBe("pending");
    await t.call("POST", `/orders/${recent.id}/stop`, { token: ali.token });
  });

  it("refuse la suite d'une commande inconnue ou d'une autre équipe", async () => {
    const sam = await t.signUp("sam-suite@exemple.org", "Sam");
    const order = (await orders())[0] as Order;
    const route = `/orders/${order.id}/follow-up`;
    const body = { brief: "x" };
    expect((await t.call("POST", route, { token: sam.token, body })).status).toBe(404);
    expect((await t.call("POST", route, { token: ali.token, body: { brief: " " } })).status).toBe(400);
  });
});
