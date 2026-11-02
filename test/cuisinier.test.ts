import type { MemoryResponse, Message, Order, OrdersResponse, Project, Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChain } from "../src/ai/client.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ai = new ScriptedAi();
const chain = parseChain("gemini:faux", { gemini: "cle" });

let t: TestApp;
let chef: { token: string; userId: string };
let ali: { token: string; userId: string };
let fatou: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  t = await startApp({ ai, serveurChain: chain, cuisinierChain: chain });
  chef = await t.signUp("chef@exemple.org", "Dominique");
  const team = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "É" } }))
    .json.team;
  const code = (
    await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })
  ).json.code;
  ali = await t.signUp("ali@exemple.org", "Ali", code);
  fatou = await t.signUp("fatou@exemple.org", "Fatou", code);
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "Site" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

/** Un membre demande un livrable ; le serveur (simulé) passe la commande. */
async function request(token: string, title: string) {
  ai.replies.push({
    category: "request",
    reply: "Je passe la commande en cuisine.",
    memory: [{ op: "add", type: "task", text: title }],
    order: { title, brief: `Réaliser : ${title}.` },
  });
  await t.call("POST", `/projects/${projectId}/messages`, { token, body: { body: `@bria ${title}` } });
  await t.serveur?.idle();
  return (await orders())[0] as Order;
}

const orders = async () =>
  (await t.call<OrdersResponse>("GET", `/projects/${projectId}/orders`, { token: chef.token })).json.orders;
const history = async () =>
  (
    await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages?limit=100`, {
      token: chef.token,
    })
  ).json.messages;

/** Une fausse machine : elle annonce le projet et répond aux outils avec `answer`. */
async function machine(
  token: string,
  lending: boolean,
  answer: (tool: string, input: Record<string, unknown>) => string | Promise<string>,
) {
  const live = await t.live(token);
  const { connectionId } = await live.next("welcome");
  const tools: string[] = [];
  let running = true;
  void (async () => {
    while (running) {
      const call = await live.next("tool.call");
      if (!running) return;
      tools.push(call.tool);
      const output = await answer(call.tool, call.input as Record<string, unknown>);
      live.socket.send(JSON.stringify({ type: "tool.result", callId: call.callId, ok: true, output }));
    }
  })();
  live.socket.send(JSON.stringify({ type: "machine.status", projects: [projectId], lending }));
  return {
    tools,
    /** Ferme la machine et attend que le serveur l'ait retirée. */
    close: async () => {
      running = false;
      live.socket.close();
      await live.closed;
      await waitFor(async () => !t.ctx.hub.byId(connectionId));
    },
  };
}

describe("cuisinier", () => {
  it("attend une machine, travaille chez le demandeur, puis rend compte", async () => {
    const order = await request(ali.token, "Page de contact");
    expect(order).toMatchObject({ number: 1, status: "pending", title: "Page de contact" });

    ai.turns.push(
      { calls: [{ name: "read_file", input: { path: "index.html" } }] },
      { calls: [{ name: "write_file", input: { path: "contact.html", content: "<form></form>" } }] },
      {
        calls: [{ name: "finish", input: { success: true, summary: "La page **contact.html** est créée." } }],
      },
    );
    const aliMachine = await machine(ali.token, false, (tool) =>
      tool === "read_file" ? "<html></html>" : "Fichier écrit.",
    );
    await waitFor(async () => (await orders())[0]?.status === "done");
    await aliMachine.close();

    expect(aliMachine.tools).toEqual(["read_file", "write_file"]);
    const done = (await orders())[0];
    expect(done).toMatchObject({
      status: "done",
      machine: { displayName: "Ali" },
      changedFiles: ["contact.html"],
      summary: "La page **contact.html** est créée.",
    });
    expect(done?.steps.map((step) => step.text)).toContain("Modifié : contact.html");

    const cook = (await history()).filter((message) => message.author.kind === "cuisinier");
    expect(cook.map((message) => message.body)).toEqual([
      expect.stringContaining("Je commence la **commande n° 1**"),
      expect.stringContaining("**Commande n° 1 terminée**"),
    ]);
    expect(cook[1]?.body).toContain("`contact.html`");

    // Le cuisinier a reçu les consignes rédigées par le serveur.
    const prompt = ai.toolRequests[0]?.messages[1];
    expect(prompt?.role === "user" ? prompt.content : "").toContain("Réaliser : Page de contact.");
    // La tâche de la mémoire est résolue.
    const memory = (
      await t.call<MemoryResponse>("GET", `/projects/${projectId}/memory`, { token: chef.token })
    ).json.items;
    expect(memory.find((item) => item.text === "Page de contact")?.status).toBe("resolved");
  });

  it("travaille chez un membre qui prête sa machine si le demandeur n'est pas connecté", async () => {
    await request(chef.token, "Pied de page");
    ai.turns.push({ calls: [{ name: "finish", input: { success: true, summary: "Fait." } }] });
    // Fatou ne prête pas sa machine : rien ne démarre.
    const fatouMachine = await machine(fatou.token, false, () => "");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await orders())[0]?.status).toBe("pending");
    // Ali la prête : la commande du chef démarre chez lui.
    const aliMachine = await machine(ali.token, true, () => "");
    await waitFor(async () => (await orders())[0]?.status === "done");
    expect((await orders())[0]).toMatchObject({ status: "done", machine: { displayName: "Ali" } });
    await fatouMachine.close();
    await aliMachine.close();
  });

  it("seuls le demandeur et le chef arrêtent une commande", async () => {
    const order = await request(ali.token, "Mentions légales");
    expect((await t.call("POST", `/orders/${order.id}/stop`, { token: fatou.token })).status).toBe(403);
    const stopped = await t.call<{ order: Order }>("POST", `/orders/${order.id}/stop`, { token: chef.token });
    expect(stopped.json.order.status).toBe("stopped");
  });

  it("travaille sur la branche de la commande quand le projet a un dépôt GitHub", async () => {
    const repo = { fullName: "dominique/site", defaultBranch: "main" };
    const byMember = await t.call("PUT", `/projects/${projectId}/repo`, {
      token: fatou.token,
      body: { repo },
    });
    expect(byMember.status).toBe(403);
    const linked = await t.call<{ project: Project }>("PUT", `/projects/${projectId}/repo`, {
      token: chef.token,
      body: { repo },
    });
    expect(linked.json.project.repo).toEqual(repo);
    const announced = (await history()).filter((message) => message.author.kind === "serveur").at(-1);
    expect(announced?.body).toContain("**dominique/site** est branché");

    const order = await request(ali.token, "Page à propos");
    ai.turns.push({ calls: [{ name: "finish", input: { success: true, summary: "La page est créée." } }] });
    const aliMachine = await machine(ali.token, false, (tool) =>
      tool === "git_save"
        ? JSON.stringify({ commit: "abc1234", pushed: true, note: "Commit abc1234 poussé sur GitHub." })
        : "Branche prête.",
    );
    await waitFor(async () => (await orders())[0]?.status === "done");
    await aliMachine.close();

    // Branche préparée avant le travail de l'IA, commit et push après.
    expect(aliMachine.tools).toEqual(["git_prepare", "git_save"]);
    const done = (await orders())[0];
    expect(done).toMatchObject({
      branch: `bria/${order.number}-page-a-propos`,
      commit: "abc1234",
      pushed: true,
    });
    expect(done?.summary).toContain("Commit abc1234 poussé sur GitHub.");

    // Le demandeur valide : sa machine a fusionné la pull request, le serveur l'enregistre.
    const route = `/orders/${order.id}/pull-request`;
    expect(
      (await t.call("PUT", route, { token: fatou.token, body: { number: 7, merged: true } })).status,
    ).toBe(403);
    const open = await t.call<{ order: Order }>("PUT", route, {
      token: ali.token,
      body: { number: 7, merged: false },
    });
    expect(open.json.order).toMatchObject({
      pullRequest: { number: 7, url: "https://github.com/dominique/site/pull/7" },
      merged: false,
    });
    const countMerged = async () =>
      (await history()).filter((message) => message.body.includes("est validée et fusionnée")).length;
    expect(await countMerged()).toBe(0);
    const merged = await t.call<{ order: Order }>("PUT", route, {
      token: ali.token,
      body: { number: 7, merged: true },
    });
    expect(merged.json.order.merged).toBe(true);
    expect(await countMerged()).toBe(1);
    const announcement = (await history()).find((message) =>
      message.body.includes("est validée et fusionnée"),
    );
    expect(announcement?.mentions).toContain(fatou.userId);
    expect(announcement?.mentions).not.toContain(ali.userId);
    // Une seconde validation n'annonce rien de plus.
    await t.call("PUT", route, { token: ali.token, body: { number: 7, merged: true } });
    expect(await countMerged()).toBe(1);

    // Pousser plus tard : réservé au propriétaire de la machine.
    expect((await t.call("POST", `/orders/${order.id}/pushed`, { token: fatou.token })).status).toBe(403);
    expect((await t.call("POST", `/orders/${order.id}/pushed`, { token: ali.token })).status).toBe(200);

    const unlinked = await t.call<{ project: Project }>("PUT", `/projects/${projectId}/repo`, {
      token: chef.token,
      body: { repo: null },
    });
    expect(unlinked.json.project.repo).toBeNull();
  });

  it("passe le relais à une autre machine avec le travail poussé et une note", async () => {
    const repo = { fullName: "dominique/site", defaultBranch: "main" };
    await t.call("PUT", `/projects/${projectId}/repo`, { token: chef.token, body: { repo } });

    const order = await request(ali.token, "Page de tarifs");
    ai.turns.push(
      { calls: [{ name: "read_file", input: { path: "index.html" } }] },
      {
        calls: [
          {
            name: "handoff",
            input: { done: "La page existe.", remaining: "Les prix.", commands: ["npm test"] },
          },
        ],
      },
    );
    const relayRoute = `/orders/${order.id}/relay`;
    let pushRequested: unknown;
    let relayStatus = 0;
    const aliMachine = await machine(ali.token, false, async (tool, input) => {
      if (tool === "read_file") {
        // Le membre demande le relais pendant que le cuisinier travaille.
        relayStatus = (await t.call("POST", relayRoute, { token: ali.token })).status;
        return "<html></html>";
      }
      if (tool === "git_save") {
        pushRequested = input.push;
        return JSON.stringify({ commit: "def5678", pushed: true, note: "Poussé." });
      }
      return "Branche prête.";
    });
    await waitFor(async () => (await orders())[0]?.handoffNote !== null);
    expect(relayStatus).toBe(200);
    expect(pushRequested).toBe(true);
    expect(aliMachine.tools).toEqual(["git_prepare", "read_file", "git_save"]);
    const waiting = (await orders())[0];
    expect(waiting).toMatchObject({ status: "pending", commit: "def5678", pushed: true });
    expect(waiting?.handoffNote).toContain("Les prix.");
    expect(waiting?.handoffNote).toContain("`npm test`");
    // La machine quittée, pourtant celle du demandeur, ne reprend pas la commande.
    await t.kitchen?.schedule();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await orders())[0]?.status).toBe("pending");

    // Une machine prêtée reprend, sur la même branche, avec la note.
    ai.turns.push({ calls: [{ name: "finish", input: { success: true, summary: "Tarifs terminés." } }] });
    const fatouMachine = await machine(fatou.token, true, (tool) =>
      tool === "git_save"
        ? JSON.stringify({ commit: "aaa1111", pushed: true, note: "Poussé." })
        : "Branche reprise.",
    );
    await waitFor(async () => (await orders())[0]?.status === "done");
    expect(fatouMachine.tools).toEqual(["git_prepare", "git_save"]);
    const resumed = ai.toolRequests.at(-1)?.messages[1]?.content;
    expect(resumed).toContain("Note de reprise");
    expect(resumed).toContain("Les prix.");
    expect(resumed).toContain("check_environment");
    await aliMachine.close();
    await fatouMachine.close();
    await t.call("PUT", `/projects/${projectId}/repo`, { token: chef.token, body: { repo: null } });
  });

  it("refuse le relais d'une commande sans dépôt ou à quelqu'un d'autre", async () => {
    const order = await request(ali.token, "Sans dépôt");
    ai.turns.push({ calls: [{ name: "read_file", input: { path: "a.txt" } }] });
    const statuses: number[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aliMachine = await machine(ali.token, false, async () => {
      statuses.push((await t.call("POST", `/orders/${order.id}/relay`, { token: fatou.token })).status);
      statuses.push((await t.call("POST", `/orders/${order.id}/relay`, { token: ali.token })).status);
      release();
      return "contenu";
    });
    ai.turns.push({ calls: [{ name: "finish", input: { success: true, summary: "Fini." } }] });
    await held;
    await waitFor(async () => (await orders())[0]?.status === "done");
    await aliMachine.close();
    expect(statuses).toEqual([403, 409]);
  });

  it("remet la commande en attente si la machine se déconnecte en cours de route", async () => {
    await request(ali.token, "Plan du site");
    // L'IA demande un fichier ; la machine se ferme avant de répondre.
    ai.turns.push({ calls: [{ name: "read_file", input: { path: "a.txt" } }] });
    const live = await t.live(ali.token);
    await live.next("welcome");
    live.socket.send(JSON.stringify({ type: "machine.status", projects: [projectId], lending: false }));
    await live.next("tool.call");
    live.socket.close();
    await waitFor(async () => (await orders())[0]?.status === "pending");
    const steps = (await orders())[0]?.steps.map((step) => step.text) ?? [];
    expect(steps.some((text) => text.includes("La machine s'est déconnectée"))).toBe(true);
    // Sans autre machine, la commande explique comment la débloquer.
    expect(steps.at(-1)).toContain("associez un dossier à ce projet");
    // La machine suivante apprend qu'il s'agit d'une reprise et ce qui s'était passé.
    ai.turns.push({ calls: [{ name: "finish", input: { success: true, summary: "Plan fait." } }] });
    const next = await machine(ali.token, false, () => "ok");
    await waitFor(async () => (await orders())[0]?.status === "done");
    await next.close();
    const resumed = ai.toolRequests.at(-1)?.messages[1]?.content;
    expect(resumed).toContain("s'est déconnectée en pleine tâche");
    expect(resumed).toContain("Le cuisinier commence sur la machine de Ali.");
    expect(resumed).not.toContain("En attente d'une machine");
  });
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Condition non atteinte à temps. Commandes : ${JSON.stringify((await orders()).map((o) => [o.number, o.status, o.steps.map((s) => s.text)]))} ; tours restants : ${ai.turns.length} ; réponses restantes : ${ai.replies.length}`,
  );
}
