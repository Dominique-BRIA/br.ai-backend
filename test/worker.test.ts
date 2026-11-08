import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Order, Project, Team } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudTools, connectWorker, deliverTo } from "../packages/worker/src/index.ts";
import { parseChain } from "../src/ai/client.ts";
import { projects } from "../src/db/schema.ts";
import { GitHubApp } from "../src/services/githubApp.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ORDER = "11111111-1111-4111-8111-111111111111";
const NEXT_ORDER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup(cloneBase?: string) {
  const base = mkdtempSync(join(tmpdir(), "bria-travailleur-"));
  const workRoot = join(base, "travail");
  const spacesRoot = join(base, "espaces");
  mkdirSync(workRoot);
  mkdirSync(spacesRoot);
  const askpass = join(base, "askpass.sh");
  writeFileSync(askpass, '#!/bin/sh\necho "$BRIA_GIT_TOKEN"\n');
  chmodSync(askpass, 0o700);
  const delivered: { orderId: string; name: string; bytes: Uint8Array }[] = [];
  const options = {
    workRoot,
    spacesRoot,
    askpass,
    cloneBase,
    deliver: async (orderId: string, name: string, bytes: Uint8Array) => {
      delivered.push({ orderId, name, bytes });
      return "33333333-3333-4333-8333-333333333333";
    },
  };
  return { base, workRoot, spacesRoot, askpass, delivered, options, tools: new CloudTools(options) };
}

const prepare = (tools: CloudTools, order = ORDER, space = PROJECT) =>
  tools.handle(order, "cloud_prepare", { space, repo: null });

/** Le contenu d'un .zip reçu : chemin -> texte. */
const contents = (bytes: Uint8Array | undefined) =>
  Object.fromEntries(Object.entries(unzipSync(bytes ?? new Uint8Array())).map(([k, v]) => [k, strFromU8(v)]));

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

describe("espace réservé du projet", () => {
  it("garde les fichiers d'une commande à l'autre", async () => {
    const { tools, spacesRoot, workRoot } = setup();
    expect((await tools.handle(ORDER, "write_file", { path: "a.md", content: "x" })).ok).toBe(false);
    expect((await prepare(tools)).output).toBe("Espace du projet prêt sur la machine cloud.");
    expect(await tools.handle(ORDER, "write_file", { path: "doc/a.md", content: "# A" })).toEqual({
      ok: true,
      output: "Fichier créé : doc/a.md",
    });
    await tools.handle(ORDER, "cloud_cleanup", {});
    // Rangé dans le coffre : plus rien dans le dossier accessible au compte des commandes.
    expect(readdirSync(workRoot)).toEqual([]);
    expect(readFileSync(join(spacesRoot, PROJECT, "doc", "a.md"), "utf8")).toBe("# A");

    await prepare(tools, NEXT_ORDER);
    expect((await tools.handle(NEXT_ORDER, "read_file", { path: "doc/a.md" })).output).toBe("# A");
    expect(
      (await tools.handle(NEXT_ORDER, "edit_file", { path: "doc/a.md", old_text: "# A", new_text: "# B" }))
        .ok,
    ).toBe(true);
    expect((await tools.handle(NEXT_ORDER, "search", { query: "# B" })).output).toContain("a.md:1");
  });

  it("ne montre à une commande que l'espace de son projet", async () => {
    const { tools, workRoot, spacesRoot } = setup();
    await prepare(tools);
    await tools.handle(ORDER, "write_file", { path: "prive.md", content: "secret du projet A" });
    await tools.handle(ORDER, "cloud_cleanup", {});

    await prepare(tools, NEXT_ORDER, OTHER_PROJECT);
    expect((await tools.handle(NEXT_ORDER, "read_file", { path: "prive.md" })).ok).toBe(false);
    const stored = join(spacesRoot, PROJECT, "prive.md");
    expect((await tools.handle(NEXT_ORDER, "read_file", { path: stored })).ok).toBe(false);
    expect(
      (await tools.handle(NEXT_ORDER, "read_file", { path: `../../espaces/${PROJECT}/prive.md` })).ok,
    ).toBe(false);
    // Seul le projet en cours (et son dossier personnel) est hors du coffre.
    expect(readdirSync(workRoot).sort()).toEqual([OTHER_PROJECT, `${OTHER_PROJECT}-maison`]);
  });

  it("efface ce qu'une installation peut recréer, et rien d'autre", async () => {
    const { tools, spacesRoot } = setup();
    await prepare(tools);
    await tools.handle(ORDER, "write_file", { path: "node_modules/x.js", content: "x" });
    await tools.handle(ORDER, "write_file", { path: "rapport.md", content: "# R" });
    await tools.handle(ORDER, "cloud_cleanup", {});
    expect(readdirSync(join(spacesRoot, PROJECT))).toEqual(["rapport.md"]);
  });

  it("remet l'espace au coffre après une coupure", async () => {
    const { options, tools, spacesRoot, workRoot } = setup();
    await prepare(tools);
    await tools.handle(ORDER, "write_file", { path: "note.md", content: "gardée" });
    // La machine redémarre sans avoir pu ranger.
    await new CloudTools(options).recover();
    expect(readdirSync(workRoot)).toEqual([]);
    expect(readFileSync(join(spacesRoot, PROJECT, "note.md"), "utf8")).toBe("gardée");
  });

  it("arrête les commandes en cours à la fin de la commande", {
    skip: process.platform === "win32",
    timeout: 30_000,
  }, async () => {
    const { tools } = setup();
    await prepare(tools);
    const started = Date.now();
    const long = tools.handle(ORDER, "run_command", { command: "sleep 60", timeout_seconds: 60 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await tools.handle(ORDER, "cloud_cleanup", {});
    await long;
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("fichier .zip", () => {
  it("n'envoie ni ne garde le dossier de travail du cuisinier", async () => {
    const { tools, delivered, spacesRoot } = setup();
    await prepare(tools);
    await tools.handle(ORDER, "write_file", { path: ".travail/creer.py", content: "print(1)" });
    await tools.handle(ORDER, "write_file", { path: "rapport.md", content: "# R" });
    const answer = JSON.parse((await tools.handle(ORDER, "cloud_collect", { name: "a.zip" })).output);
    expect(answer).toMatchObject({ files: 1, names: ["rapport.md"] });
    expect(Object.keys(contents(delivered[0]?.bytes))).toEqual(["rapport.md"]);
    await tools.handle(ORDER, "cloud_cleanup", {});
    expect(readdirSync(join(spacesRoot, PROJECT))).toEqual(["rapport.md"]);
  });

  it("garde le refus des suppressions forcées", async () => {
    const { tools } = setup();
    await prepare(tools);
    const answer = await tools.handle(ORDER, "run_command", { command: "rm -f a.txt", timeout_seconds: 10 });
    expect(answer.ok).toBe(false);
    expect(answer.output).toContain("suppression de fichiers");
  });

  it("contient l'espace du projet, sans les dossiers techniques", async () => {
    const { tools, delivered } = setup();
    await prepare(tools);
    await tools.handle(ORDER, "write_file", { path: "rapport.md", content: "# Rapport" });
    await tools.handle(ORDER, "write_file", { path: "images/note.txt", content: "note" });
    await tools.handle(ORDER, "write_file", { path: "node_modules/x.js", content: "ignoré" });
    const answer = JSON.parse((await tools.handle(ORDER, "cloud_collect", { name: "rapport.zip" })).output);
    expect(answer).toMatchObject({ attachmentId: "33333333-3333-4333-8333-333333333333", files: 2 });
    expect(delivered[0]).toMatchObject({ orderId: ORDER, name: "rapport.zip" });
    expect(contents(delivered[0]?.bytes)).toEqual({ "images/note.txt": "note", "rapport.md": "# Rapport" });
  });

  it("refuse un nom de fichier qui sortirait du format attendu", async () => {
    const { tools } = setup();
    await prepare(tools);
    expect((await tools.handle(ORDER, "cloud_collect", { name: "../x.zip" })).ok).toBe(false);
  });

  it("dit quand il n'y a rien à envoyer, ou que c'est trop gros", async () => {
    const { tools, delivered, workRoot } = setup();
    await prepare(tools);
    const empty = JSON.parse((await tools.handle(ORDER, "cloud_collect", { name: "a.zip" })).output);
    expect(empty).toMatchObject({ attachmentId: null, files: 0 });

    // Des octets aléatoires ne se compriment pas : le .zip dépasse les 20 Mo.
    writeFileSync(join(workRoot, PROJECT, "gros.bin"), randomBytes(21 * 1024 * 1024));
    const big = JSON.parse((await tools.handle(ORDER, "cloud_collect", { name: "a.zip" })).output);
    expect(big.attachmentId).toBeNull();
    expect(big.note).toContain("dépasse la limite");
    expect(delivered).toHaveLength(0);
  }, 60_000);
});

describe("sécurité de la machine cloud", () => {
  it("garde l'IA dans le dossier de la commande", async () => {
    const { base, workRoot, tools, delivered } = setup();
    const secret = join(base, "secret.txt");
    writeFileSync(secret, "valeur secrète");
    await prepare(tools);

    expect((await tools.handle(ORDER, "read_file", { path: "../../secret.txt" })).ok).toBe(false);
    expect((await tools.handle(ORDER, "read_file", { path: secret })).ok).toBe(false);
    expect((await tools.handle(ORDER, "write_file", { path: "../x.txt", content: "x" })).ok).toBe(false);
    expect((await tools.handle(ORDER, "write_env", { path: ".env" })).ok).toBe(false);
    expect((await tools.handle(ORDER, "write_file", { path: ".git/config", content: "x" })).ok).toBe(false);

    // Un lien symbolique ne fait pas sortir du dossier, ni par les outils, ni dans le .zip.
    let linked = true;
    try {
      symlinkSync(secret, join(workRoot, PROJECT, "lien.txt"));
      symlinkSync(base, join(workRoot, PROJECT, "dehors"));
    } catch {
      linked = false; // Windows peut refuser les liens symboliques.
    }
    if (linked) {
      expect((await tools.handle(ORDER, "read_file", { path: "lien.txt" })).ok).toBe(false);
      expect((await tools.handle(ORDER, "read_file", { path: "dehors/secret.txt" })).ok).toBe(false);
      expect((await tools.handle(ORDER, "write_file", { path: "dehors/y.txt", content: "y" })).ok).toBe(
        false,
      );
      await tools.handle(ORDER, "write_file", { path: "vrai.md", content: "ok" });
      await tools.handle(ORDER, "cloud_collect", { name: "a.zip" });
      expect(Object.keys(contents(delivered[0]?.bytes))).toEqual(["vrai.md"]);
    }
  });

  it("refuse les commandes dangereuses et ne transmet aucun jeton aux commandes", async () => {
    const { tools } = setup();
    process.env.BRIA_TEST_SECRET = "ne-doit-pas-sortir";
    await prepare(tools);
    const refused = await tools.handle(ORDER, "run_command", { command: "sudo ls", timeout_seconds: 10 });
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("élévation de privilèges");

    const env = await tools.handle(ORDER, "run_command", { command: "env", timeout_seconds: 20 });
    expect(env.ok).toBe(true);
    expect(env.output).not.toContain("ne-doit-pas-sortir");
    delete process.env.BRIA_TEST_SECRET;
  }, 30_000);

  it("clone, commite au nom du demandeur et pousse sans laisser le jeton", async () => {
    const seed = setup();
    const { remote, cloneBase } = remoteRepo(seed.base);
    const { tools, workRoot, delivered, spacesRoot } = setup(cloneBase);
    const repo = {
      fullName: "ali/site",
      token: "jeton-tres-secret",
      author: { name: "Ali Membre", email: "abc@users.noreply.br.garah.me" },
    };
    expect(await tools.handle(ORDER, "cloud_prepare", { space: PROJECT, repo })).toEqual({
      ok: true,
      output: "Dépôt ali/site cloné sur la machine cloud.",
    });
    expect(await tools.handle(ORDER, "git_prepare", { branch: "bria/1-page", base: "main" })).toEqual({
      ok: true,
      output: "Branche bria/1-page créée depuis main.",
    });
    await tools.handle(ORDER, "write_file", { path: "page.html", content: "<p></p>\n" });
    await tools.handle(ORDER, "write_file", { path: ".travail/brouillon.py", content: "print(1)" });
    const saved = JSON.parse(
      (await tools.handle(ORDER, "git_save", { branch: "bria/1-page", message: "Page\n\nCommande n° 1." }))
        .output,
    );
    expect(saved.pushed).toBe(true);
    expect(inRemote(remote, "ls-tree", "-r", "--name-only", "bria/1-page")).not.toContain(".travail");

    const log = inRemote(remote, "log", "-1", "--format=%an <%ae>%n%B", "bria/1-page");
    expect(log).toContain("Ali Membre <abc@users.noreply.br.garah.me>");
    expect(log).not.toMatch(/co-authored|claude|\bIA\b/i);
    // Le jeton n'est écrit nulle part dans le dépôt.
    expect(readFileSync(join(workRoot, PROJECT, ".git", "config"), "utf8")).not.toContain(
      "jeton-tres-secret",
    );
    // Le .zip contient le travail, sans `.git`.
    await tools.handle(ORDER, "cloud_collect", { name: "page.zip" });
    expect(Object.keys(contents(delivered[0]?.bytes)).sort()).toEqual(["index.html", "page.html"]);

    // Un clone n'est pas gardé : GitHub reste sa place ; une reprise repart de ce qui est poussé.
    await tools.handle(ORDER, "cloud_cleanup", {});
    expect(readdirSync(spacesRoot)).toEqual([]);
    await tools.handle(NEXT_ORDER, "cloud_prepare", {
      space: PROJECT,
      repo: { ...repo, token: "autre-jeton" },
    });
    expect(
      (await tools.handle(NEXT_ORDER, "git_prepare", { branch: "bria/1-page", base: "main" })).output,
    ).toBe("Branche bria/1-page reprise depuis GitHub.");
    expect((await tools.handle(NEXT_ORDER, "read_file", { path: "page.html" })).ok).toBe(true);
  }, 60_000);
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
    const seed = setup();
    const repo = remoteRepo(seed.base);
    remote = repo.remote;
    const { options } = setup(repo.cloneBase);
    const serverUrl = t.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
    const connection = connectWorker({
      serverUrl,
      token: machine.json.token,
      tools: new CloudTools({ ...options, deliver: deliverTo(serverUrl, machine.json.token) }),
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
  const lastMessage = async () =>
    (
      await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages`, { token: ali.token })
    ).json.messages.at(-1);

  it("envoie le .zip dans le chat, téléchargeable par l'équipe", async () => {
    ai.turns.push(
      { calls: [{ name: "write_file", input: { path: "fiche.md", content: "# Fiche" } }] },
      { calls: [{ name: "read_file", input: { path: "fiche.md" } }] },
      { calls: [{ name: "finish", input: { success: true, summary: "Fiche prête." } }] },
    );
    const placed = await t.call<{ order: Order }>("POST", `/projects/${projectId}/orders`, {
      token: ali.token,
      body: { title: "Fiche de révision", brief: "Écrire une fiche.", runOn: "cloud" },
    });
    expect((await waitDone(placed.json.order.id)).status).toBe("done");

    expect((await lastMessage())?.body).toContain("**Dans le fichier .zip** : `fiche.md`.");
    expect((await lastMessage())?.body).not.toContain("Fichiers modifiés");
    const file = (await lastMessage())?.attachments[0];
    expect(file).toMatchObject({ name: "commande-1-fiche-de-revision.zip", contentType: "application/zip" });
    const download = await t.app.inject({
      method: "GET",
      url: `/attachments/${file?.id}`,
      headers: { authorization: `Bearer ${ali.token}` },
    });
    expect(contents(new Uint8Array(download.rawPayload))).toEqual({ "fiche.md": "# Fiche" });
  }, 60_000);

  it("retrouve l'espace du projet à la commande suivante, et complète le .zip", async () => {
    ai.turns.push(
      { calls: [{ name: "read_file", input: { path: "fiche.md" } }] },
      { calls: [{ name: "write_file", input: { path: "plan.md", content: "# Plan" } }] },
      { calls: [{ name: "read_file", input: { path: "plan.md" } }] },
      { calls: [{ name: "finish", input: { success: true, summary: "Plan ajouté." } }] },
    );
    const placed = await t.call<{ order: Order }>("POST", `/projects/${projectId}/orders`, {
      token: ali.token,
      body: { title: "Plan", brief: "Ajouter un plan.", runOn: "cloud" },
    });
    await waitDone(placed.json.order.id);
    const reads = ai.toolRequests.at(-1)?.messages.filter((message) => message.role === "tool");
    expect(reads?.[0]?.content).toBe("# Fiche");
    const file = (await lastMessage())?.attachments[0];
    const download = await t.app.inject({
      method: "GET",
      url: `/attachments/${file?.id}`,
      headers: { authorization: `Bearer ${ali.token}` },
    });
    expect(Object.keys(contents(new Uint8Array(download.rawPayload))).sort()).toEqual([
      "fiche.md",
      "plan.md",
    ]);
  }, 60_000);

  it("envoie une demande à @bria sur le cloud quand aucune machine n'a le projet", async () => {
    ai.replies.push({
      category: "request",
      reply: "Je passe la commande.",
      memory: [],
      order: { title: "Présentation", brief: "Préparer une présentation." },
    });
    ai.turns.push({ calls: [{ name: "finish", input: { success: true, summary: "Présentation prête." } }] });
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: ali.token,
      body: { body: "@bria prépare une présentation" },
    });
    await t.serveur?.idle();
    const created = (await orders())[0] as Order;
    expect(created).toMatchObject({ title: "Présentation", runOn: "cloud" });
    expect((await waitDone(created.id)).status).toBe("done");
  }, 60_000);

  it("pousse la branche au nom du demandeur sur un projet avec dépôt", async () => {
    await t.call("PUT", `/projects/${projectId}/repo`, {
      token: ali.token,
      body: { repo: { fullName: "ali/site", defaultBranch: "main" } },
    });
    await t.db.update(projects).set({ repoInstallationId: 77 }).where(eq(projects.id, projectId));

    ai.turns.push(
      { calls: [{ name: "write_file", input: { path: "tarifs.html", content: "<p>Tarifs</p>\n" } }] },
      { calls: [{ name: "read_file", input: { path: "tarifs.html" } }] },
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
    expect((await lastMessage())?.attachments[0]?.name).toContain("page-tarifs");
  }, 60_000);
});
