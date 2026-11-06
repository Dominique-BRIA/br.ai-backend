import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Order, Project, Team } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudTools, connectWorker } from "../packages/worker/src/index.ts";
import { parseChain } from "../src/ai/client.ts";
import { projects } from "../src/db/schema.ts";
import { GitHubApp } from "../src/services/githubApp.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ORDER = "11111111-1111-4111-8111-111111111111";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup() {
  const base = mkdtempSync(join(tmpdir(), "bria-travailleur-"));
  const workRoot = join(base, "travail");
  mkdirSync(workRoot);
  const askpass = join(base, "askpass.sh");
  writeFileSync(askpass, '#!/bin/sh\necho "$BRIA_GIT_TOKEN"\n');
  chmodSync(askpass, 0o700);
  return { base, workRoot, askpass };
}

/** Un « GitHub » local : un dépôt nu `ali/site.git`, avec un premier commit sur main. */
function remoteRepo(base: string) {
  const github = join(base, "github");
  const remote = join(github, "ali", "site.git");
  mkdirSync(join(github, "ali"), { recursive: true });
  run(base, "init", "--bare", "--initial-branch=main", remote);
  const seed = join(base, "graine");
  run(base, "clone", remote, seed);
  run(seed, "config", "user.name", "Graine");
  run(seed, "config", "user.email", "graine@exemple.org");
  run(seed, "checkout", "-b", "main");
  writeFileSync(join(seed, "index.html"), "<h1>Accueil</h1>\n");
  run(seed, "add", "--all");
  run(seed, "commit", "-m", "Premier commit");
  run(seed, "push", "--set-upstream", "origin", "main");
  return { remote, cloneBase: `file://${github.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}/` };
}

const inRemote = (remote: string, ...args: string[]) => run(join(remote, ".."), "--git-dir", remote, ...args);

describe("outils de la machine cloud", () => {
  it("travaille dans un dossier vide, rend les fichiers, puis efface tout", async () => {
    const { workRoot, askpass } = setup();
    const tools = new CloudTools({ workRoot, askpass });
    expect((await tools.handle(ORDER, "write_file", { path: "a.md", content: "x" })).ok).toBe(false);
    expect((await tools.handle(ORDER, "cloud_prepare", { repo: null })).ok).toBe(true);
    expect(await tools.handle(ORDER, "write_file", { path: "doc/a.md", content: "# A" })).toEqual({
      ok: true,
      output: "Fichier créé : doc/a.md",
    });
    await tools.handle(ORDER, "write_file", { path: "node_modules/x.js", content: "ignoré" });
    expect((await tools.handle(ORDER, "read_file", { path: "doc/a.md" })).output).toBe("# A");
    expect((await tools.handle(ORDER, "search", { query: "# A" })).output).toContain("a.md:1");
    expect(
      (await tools.handle(ORDER, "edit_file", { path: "doc/a.md", old_text: "# A", new_text: "# B" })).ok,
    ).toBe(true);

    const collected = JSON.parse((await tools.handle(ORDER, "cloud_collect", {})).output);
    expect(collected.skipped).toBe(0);
    expect(collected.files).toEqual([
      { path: "doc/a.md", contentType: "text/markdown", base64: Buffer.from("# B").toString("base64") },
    ]);

    await tools.handle(ORDER, "cloud_cleanup", {});
    expect(existsSync(join(workRoot, ORDER))).toBe(false);
  });

  it("garde l'IA dans le dossier de la commande", async () => {
    const { base, workRoot, askpass } = setup();
    const secret = join(base, "secret.txt");
    writeFileSync(secret, "valeur secrète");
    const tools = new CloudTools({ workRoot, askpass });
    await tools.handle(ORDER, "cloud_prepare", { repo: null });

    expect((await tools.handle(ORDER, "read_file", { path: "../../secret.txt" })).ok).toBe(false);
    expect((await tools.handle(ORDER, "read_file", { path: secret })).ok).toBe(false);
    expect((await tools.handle(ORDER, "write_file", { path: "../x.txt", content: "x" })).ok).toBe(false);
    expect((await tools.handle(ORDER, "write_env", { path: ".env" })).ok).toBe(false);
    expect((await tools.handle(ORDER, "write_file", { path: ".git/config", content: "x" })).ok).toBe(false);

    // Un lien symbolique ne fait pas sortir du dossier, ni par les outils, ni dans les fichiers rendus.
    let linked = true;
    try {
      symlinkSync(secret, join(workRoot, ORDER, "lien.txt"));
      symlinkSync(base, join(workRoot, ORDER, "dehors"));
    } catch {
      linked = false; // Windows peut refuser les liens symboliques.
    }
    if (linked) {
      expect((await tools.handle(ORDER, "read_file", { path: "lien.txt" })).ok).toBe(false);
      expect((await tools.handle(ORDER, "read_file", { path: "dehors/secret.txt" })).ok).toBe(false);
      expect((await tools.handle(ORDER, "write_file", { path: "dehors/y.txt", content: "y" })).ok).toBe(
        false,
      );
      const collected = (await tools.handle(ORDER, "cloud_collect", {})).output;
      expect(collected).not.toContain(Buffer.from("valeur secrète").toString("base64"));
    }
  });

  it("refuse les commandes dangereuses et ne transmet aucun jeton aux commandes", async () => {
    const { workRoot, askpass } = setup();
    process.env.BRIA_TEST_SECRET = "ne-doit-pas-sortir";
    const tools = new CloudTools({ workRoot, askpass });
    await tools.handle(ORDER, "cloud_prepare", { repo: null });
    const refused = await tools.handle(ORDER, "run_command", { command: "sudo ls", timeout_seconds: 10 });
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("élévation de privilèges");

    const env = await tools.handle(ORDER, "run_command", { command: "env", timeout_seconds: 20 });
    expect(env.ok).toBe(true);
    expect(env.output).not.toContain("ne-doit-pas-sortir");
    delete process.env.BRIA_TEST_SECRET;
  }, 30_000);

  it("clone, commite au nom du demandeur et pousse sans laisser le jeton", async () => {
    const { base, workRoot, askpass } = setup();
    const { remote, cloneBase } = remoteRepo(base);
    const tools = new CloudTools({ workRoot, askpass, cloneBase });
    const prepared = await tools.handle(ORDER, "cloud_prepare", {
      repo: {
        fullName: "ali/site",
        token: "jeton-tres-secret",
        author: { name: "Ali Membre", email: "abc@users.noreply.br.garah.me" },
      },
    });
    expect(prepared).toEqual({ ok: true, output: "Dépôt ali/site cloné sur la machine cloud." });
    expect(await tools.handle(ORDER, "git_prepare", { branch: "bria/1-page", base: "main" })).toEqual({
      ok: true,
      output: "Branche bria/1-page créée depuis main.",
    });
    await tools.handle(ORDER, "write_file", { path: "page.html", content: "<p></p>\n" });
    const saved = JSON.parse(
      (await tools.handle(ORDER, "git_save", { branch: "bria/1-page", message: "Page\n\nCommande n° 1." }))
        .output,
    );
    expect(saved.pushed).toBe(true);

    const log = inRemote(remote, "log", "-1", "--format=%an <%ae>%n%B", "bria/1-page");
    expect(log).toContain("Ali Membre <abc@users.noreply.br.garah.me>");
    expect(log).not.toMatch(/co-authored|claude|\bIA\b/i);
    // Le jeton n'est écrit nulle part dans le dépôt.
    expect(readFileSync(join(workRoot, ORDER, ".git", "config"), "utf8")).not.toContain("jeton-tres-secret");

    // Une reprise repart de ce qui a été poussé.
    await tools.handle(ORDER, "cloud_cleanup", {});
    await tools.handle(ORDER, "cloud_prepare", {
      repo: { fullName: "ali/site", token: "autre-jeton", author: { name: "Ali", email: "a@b.c" } },
    });
    expect((await tools.handle(ORDER, "git_prepare", { branch: "bria/1-page", base: "main" })).output).toBe(
      "Branche bria/1-page reprise depuis GitHub.",
    );
    expect((await tools.handle(ORDER, "read_file", { path: "page.html" })).ok).toBe(true);
  }, 60_000);

  it("rend seulement les fichiers qui tiennent dans une réponse", async () => {
    const { workRoot, askpass } = setup();
    const tools = new CloudTools({ workRoot, askpass });
    await tools.handle(ORDER, "cloud_prepare", { repo: null });
    await tools.handle(ORDER, "write_file", { path: "gros.txt", content: "x".repeat(200_000) });
    await tools.handle(ORDER, "write_file", { path: "petit.txt", content: "y" });
    const collected = JSON.parse((await tools.handle(ORDER, "cloud_collect", {})).output);
    expect(collected.files.map((file: { path: string }) => file.path)).toEqual(["petit.txt"]);
    expect(collected.skipped).toBe(1);
  });
});

describe("travailleur relié au serveur", () => {
  const ai = new ScriptedAi();
  const chain = parseChain("gemini:faux", { gemini: "cle" });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  // GitHub simulé : seule la demande du jeton d'installation est attendue.
  const requested: unknown[] = [];
  const github = new GitHubApp(
    { appId: "1", slug: "br", clientId: "c", clientSecret: "s", privateKey, webhookSecret: "w" },
    (async (_url: string | URL, init?: RequestInit) => {
      requested.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ token: "jeton-installation" }), { status: 201 });
    }) as typeof fetch,
  );
  let t: TestApp;
  let ali: { token: string; userId: string };
  let projectId: string;
  let stopWorker = () => {};
  let remote = "";

  beforeAll(async () => {
    t = await startApp({ ai, serveurChain: chain, cuisinierChain: chain, githubApp: github });
    ali = await t.signUp("ali-travailleur@exemple.org", "Ali Membre");
    const team = (await t.call<{ team: Team }>("POST", "/teams", { token: ali.token, body: { name: "É" } }))
      .json.team;
    projectId = (
      await t.call<{ project: Project }>("POST", `/teams/${team.id}/projects`, {
        token: ali.token,
        body: { name: "Site" },
      })
    ).json.project.id;

    const machine = await t.call<{ token: string }>("POST", "/admin/cloud-machines", {
      admin: true,
      body: { label: "essai" },
    });
    const { base, workRoot, askpass } = setup();
    const repo = remoteRepo(base);
    remote = repo.remote;
    const connection = connectWorker({
      serverUrl: t.wsUrl.replace(/\/ws$/, ""),
      token: machine.json.token,
      tools: new CloudTools({ workRoot, askpass, cloneBase: repo.cloneBase }),
      log: { info: () => {}, error: () => {} },
    });
    stopWorker = connection.stop;
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const { json } = await t.call<{ machines: { online: boolean }[] }>("GET", "/admin/cloud-machines", {
        admin: true,
      });
      if (json.machines[0]?.online) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  afterAll(async () => {
    stopWorker();
    await t.stop();
  });

  const orders = async () =>
    (await t.call<{ orders: Order[] }>("GET", `/projects/${projectId}/orders`, { token: ali.token })).json
      .orders;
  const waitDone = async (id: string) => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const found = (await orders()).find((order) => order.id === id);
      if (found && found.status !== "pending" && found.status !== "running") return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Commande non terminée à temps.");
  };

  it("réalise une commande sans dépôt et rend le fichier dans le chat", async () => {
    ai.turns.push(
      { calls: [{ name: "write_file", input: { path: "fiche.md", content: "# Fiche" } }] },
      { calls: [{ name: "run_command", input: { command: "git --version" } }] },
      { calls: [{ name: "finish", input: { success: true, summary: "Fiche prête." } }] },
    );
    const placed = await t.call<{ order: Order }>("POST", `/projects/${projectId}/orders`, {
      token: ali.token,
      body: { title: "Fiche", brief: "Écrire une fiche.", runOn: "cloud" },
    });
    const done = await waitDone(placed.json.order.id);
    expect(done.status).toBe("done");
    const { messages } = (
      await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages`, { token: ali.token })
    ).json;
    expect(messages.at(-1)?.attachments.map((file) => file.name)).toEqual(["fiche.md"]);
  }, 60_000);

  it("réalise une commande sur un dépôt et pousse la branche au nom du demandeur", async () => {
    await t.call("PUT", `/projects/${projectId}/repo`, {
      token: ali.token,
      body: { repo: { fullName: "ali/site", defaultBranch: "main" } },
    });
    await t.db.update(projects).set({ repoInstallationId: 77 }).where(eq(projects.id, projectId));

    ai.turns.push(
      { calls: [{ name: "write_file", input: { path: "tarifs.html", content: "<p>Tarifs</p>\n" } }] },
      { calls: [{ name: "finish", input: { success: true, summary: "Page créée." } }] },
    );
    const placed = await t.call<{ order: Order }>("POST", `/projects/${projectId}/orders`, {
      token: ali.token,
      body: { title: "Page tarifs", brief: "Créer la page.", runOn: "cloud" },
    });
    const done = await waitDone(placed.json.order.id);
    expect(done).toMatchObject({
      status: "done",
      pushed: true,
      branch: expect.stringContaining("page-tarifs"),
    });
    // Le jeton demandé à GitHub est limité à ce dépôt, en écriture sur son contenu.
    expect(requested.at(-1)).toEqual({
      repositories: ["site"],
      permissions: { contents: "write", metadata: "read" },
    });
    const log = inRemote(remote, "log", "-1", "--format=%an <%ae>", String(done.branch));
    expect(log).toBe(`Ali Membre <${ali.userId}@users.noreply.br.garah.me>`);
  }, 60_000);
});
