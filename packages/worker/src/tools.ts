import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { cloudTools, cookTools, gitTools, isCloudTool, isCookTool, isGitTool } from "@br-ia/protocol";
import { dangerousCommand, IGNORED_DIRECTORIES, resolveInProject } from "@br-ia/protocol/safety";
import { zipSync } from "fflate";

const MAX_READ_BYTES = 300_000;
const MAX_OUTPUT = 60_000;
/** Le .zip devient une pièce jointe : même limite que les autres (20 Mo). */
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_INPUT_BYTES = 150 * 1024 * 1024;
/** Espace réservé d'un projet : prévenu, puis refusé (la VM a 30 Go pour tous les projets). */
const SPACE_WARNING_BYTES = 200 * 1024 * 1024;
const SPACE_LIMIT_BYTES = 500 * 1024 * 1024;
/** Effacés entre deux commandes : une installation les recrée, et ils prendraient toute la place. */
const DISPOSABLE_DIRECTORIES = ["node_modules", ".venv", "venv", "__pycache__", ".next", ".turbo"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Outcome {
  ok: boolean;
  output: string;
}

export interface ToolsOptions {
  /** Dossier de la commande en cours, seul accessible au compte des commandes. */
  workRoot: string;
  /** Coffre des espaces réservés aux projets, fermé au compte des commandes. */
  spacesRoot: string;
  /** Envoie le .zip d'une commande au serveur et renvoie l'identifiant de la pièce jointe. */
  deliver: (orderId: string, name: string, bytes: Uint8Array) => Promise<string>;
  /** Script qui donne le jeton à Git (voir main.ts). */
  askpass: string;
  /**
   * Compte Linux qui lance les commandes de l'IA, sans accès aux jetons ni à `.git`. Absent en
   * développement et dans les tests : tout tourne alors sous le même compte, sans cette protection.
   */
  runAs?: string;
  /** Début de l'adresse des dépôts ; seuls les tests la changent. */
  cloneBase?: string;
}

const refused = (output: string): Outcome => ({ ok: false, output });

/** Environnement réduit au strict nécessaire : ni jeton, ni rien hérité du travailleur. */
const safeEnv = (home: string) => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  LANG: "C.UTF-8",
  CI: "1",
});

/**
 * Les outils du cuisinier sur la machine cloud, sans éditeur ni personne pour répondre : ce qui
 * demande un accord sur la machine d'un membre est refusé ici. Une commande à la fois.
 */
export class CloudTools {
  readonly #options: ToolsOptions;
  #orderId: string | null = null;
  #dir: string | null = null;
  /** Où ranger le dossier à la fin : l'espace du projet ; `null` pour un clone, effacé. */
  #keep: string | null = null;
  /** Processus de la commande en cours, pour l'arrêter quand la commande s'arrête. */
  #pid: number | undefined;
  /** Les outils passent un par un : un rangement ne croise jamais la préparation suivante. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Jeton d'installation GitHub de la commande : gardé en mémoire, jamais écrit ni transmis à l'IA. */
  #token: string | null = null;

  constructor(options: ToolsOptions) {
    this.#options = options;
  }

  handle(orderId: string, tool: string, input: unknown): Promise<Outcome> {
    // Fin de commande : ce qui tourne encore s'arrête tout de suite, sans attendre son tour.
    if (tool === "cloud_cleanup" && this.#orderId === orderId) void this.#killCommands(this.#pid);
    const run = this.#queue.then(async () => {
      const outcome = await this.#dispatch(orderId, tool, input).catch(
        (error: unknown): Outcome => ({ ok: false, output: (error as Error).message }),
      );
      return { ok: outcome.ok, output: this.#mask(outcome.output) };
    });
    this.#queue = run;
    return run;
  }

  /** Par sécurité, le jeton ne ressort jamais d'une réponse, même dans une erreur de Git. */
  #mask(output: string): string {
    return this.#token ? output.replaceAll(this.#token, "•••") : output;
  }

  async #dispatch(orderId: string, tool: string, rawInput: unknown): Promise<Outcome> {
    if (isCloudTool(tool)) {
      if (tool === "cloud_prepare") {
        const parsed = cloudTools.cloud_prepare.input.safeParse(rawInput);
        if (!parsed.success) return refused("Paramètres invalides.");
        return this.#prepare(orderId, parsed.data.space, parsed.data.repo);
      }
      if (tool === "cloud_cleanup") return this.#cleanup(orderId);
      const parsed = cloudTools.cloud_collect.input.safeParse(rawInput);
      if (!parsed.success) return refused("Nom de fichier invalide.");
      return this.#collect(orderId, parsed.data.name);
    }
    const root = this.#dir;
    if (!root || this.#orderId !== orderId) return refused("Le dossier de cette commande n'est pas prêt.");

    if (isGitTool(tool)) {
      if (tool === "git_prepare") {
        const parsed = gitTools.git_prepare.input.safeParse(rawInput);
        if (!parsed.success) return refused("Paramètres invalides.");
        return this.#gitPrepare(root, parsed.data.branch, parsed.data.base);
      }
      const parsed = gitTools.git_save.input.safeParse(rawInput);
      if (!parsed.success) return refused("Paramètres invalides.");
      return this.#gitSave(root, parsed.data.branch, parsed.data.message);
    }
    if (!isCookTool(tool)) return refused(`Outil inconnu : ${tool}.`);
    if (tool === "write_env") return refused("Pas de secrets sur la machine cloud.");

    switch (tool) {
      case "read_file": {
        const input = cookTools.read_file.input.parse(rawInput);
        return this.#read(root, input.path);
      }
      case "list_dir": {
        const input = cookTools.list_dir.input.parse(rawInput);
        return this.#list(root, input.path);
      }
      case "search": {
        const input = cookTools.search.input.parse(rawInput);
        return this.#search(root, input.query, input.path);
      }
      case "write_file": {
        const input = cookTools.write_file.input.parse(rawInput);
        return this.#write(root, input.path, () => input.content);
      }
      case "edit_file": {
        const input = cookTools.edit_file.input.parse(rawInput);
        return this.#write(root, input.path, (before) => {
          if (before === null) throw new Error(`Fichier introuvable : ${input.path}`);
          const count = before.split(input.old_text).length - 1;
          if (count === 0) throw new Error("Le passage à remplacer est introuvable. Relis le fichier.");
          if (count > 1)
            throw new Error(`Le passage à remplacer apparaît ${count} fois : donne un passage plus long.`);
          return before.replace(input.old_text, () => input.new_text);
        });
      }
      case "run_command": {
        const input = cookTools.run_command.input.parse(rawInput);
        return this.#run(root, input.command, input.timeout_seconds * 1000);
      }
      default:
        return this.#environment();
    }
  }

  /**
   * Chemin dans le dossier de la commande, ou `null`. Le test porte aussi sur le chemin réel : un
   * lien symbolique créé par une commande ne doit pas ouvrir le reste de la machine (les jetons du
   * travailleur, notamment). `.git` reste hors de portée de l'IA.
   */
  async #inside(root: string, path: string): Promise<string | null> {
    const { absolute, inside } = resolveInProject(root, path);
    if (!inside || relative(root, absolute).split(sep).includes(".git")) return null;
    const realRoot = await realpath(root);
    let existing = absolute;
    for (;;) {
      const real = await realpath(existing).catch(() => null);
      if (real) return real === realRoot || real.startsWith(realRoot + sep) ? absolute : null;
      const parent = dirname(existing);
      if (parent === existing) return null;
      existing = parent;
    }
  }

  async #read(root: string, path: string): Promise<Outcome> {
    const absolute = await this.#inside(root, path);
    if (!absolute) return refused("Accès refusé : hors du dossier de la commande.");
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) return refused(`Fichier introuvable : ${path}`);
    if (info.size > MAX_READ_BYTES) return refused(`Fichier trop volumineux (${info.size} octets).`);
    const content = await readFile(absolute);
    if (content.includes(0)) return refused("Fichier binaire : il ne peut pas être lu comme du texte.");
    return { ok: true, output: content.toString("utf8") };
  }

  async #list(root: string, path: string): Promise<Outcome> {
    const absolute = await this.#inside(root, path);
    if (!absolute) return refused("Accès refusé : hors du dossier de la commande.");
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (!entries) return refused(`Dossier introuvable : ${path}`);
    const lines = entries
      .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 300)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return { ok: true, output: lines.length > 0 ? lines.join("\n") : "(dossier vide)" };
  }

  async #search(root: string, query: string, path: string): Promise<Outcome> {
    const start = await this.#inside(root, path);
    if (!start) return refused("Accès refusé : hors du dossier de la commande.");
    const results: string[] = [];
    let visited = 0;
    const walk = async (folder: string): Promise<void> => {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= 50 || visited > 3000) return;
        const full = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full);
          continue;
        }
        // Les liens symboliques ne sont pas suivis.
        if (!entry.isFile()) continue;
        visited++;
        const info = await stat(full).catch(() => null);
        if (!info || info.size > 1_000_000) continue;
        const content = await readFile(full).catch(() => null);
        if (!content || content.includes(0)) continue;
        content
          .toString("utf8")
          .split(/\r?\n/)
          .forEach((line, index) => {
            if (results.length < 50 && line.includes(query)) {
              results.push(`${relative(root, full)}:${index + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
      }
    };
    await walk(start);
    return { ok: true, output: results.length > 0 ? results.join("\n") : "Aucun résultat." };
  }

  async #write(root: string, path: string, content: (before: string | null) => string): Promise<Outcome> {
    const absolute = await this.#inside(root, path);
    if (!absolute) return refused("Écriture refusée : hors du dossier de la commande.");
    const before = await readFile(absolute, "utf8").catch(() => null);
    const after = content(before);
    if (after === before) return { ok: true, output: "Aucun changement : le contenu est identique." };
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, after);
    return { ok: true, output: before === null ? `Fichier créé : ${path}` : `Fichier modifié : ${path}` };
  }

  /** Lance une commande de l'IA, sous son compte sans droits, avec un environnement réduit. */
  #run(root: string, command: string, timeoutMs: number): Promise<Outcome> {
    const danger = dangerousCommand(command);
    if (danger) {
      return Promise.resolve(
        refused(`Commande refusée sur la machine cloud (${danger}) : personne ne peut y donner son accord.`),
      );
    }
    const { runAs } = this.#options;
    // Dossier personnel à part : les caches de npm ou de pip ne se mêlent pas aux fichiers rendus.
    const env = safeEnv(homeOf(root));
    const child = runAs
      ? spawn(
          "sudo",
          [
            "-n",
            "-u",
            runAs,
            "/usr/bin/env",
            ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
            "/bin/sh",
            "-c",
            `umask 002; ${command}`,
          ],
          { cwd: root, env },
        )
      : spawn(command, { cwd: root, shell: true, env, detached: true });

    this.#pid = child.pid;
    return new Promise((resolve) => {
      let output = "";
      const append = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
      };
      const timer = setTimeout(() => {
        output += `\n[Arrêtée après ${Math.round(timeoutMs / 1000)} s.]`;
        void this.#killCommands(child.pid);
      }, timeoutMs);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(refused(`Impossible de lancer la commande : ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const tail = output.length > MAX_OUTPUT ? `[…]\n${output.slice(-MAX_OUTPUT)}` : output;
        resolve({ ok: code === 0, output: `Code de sortie : ${code}\n${tail.trim() || "(aucune sortie)"}` });
      });
    });
  }

  /** Arrête tout ce que l'IA a lancé, y compris les processus laissés en arrière-plan. */
  async #killCommands(pid?: number): Promise<void> {
    const { runAs } = this.#options;
    if (runAs) {
      await new Promise<void>((resolve) => {
        execFile("sudo", ["-n", "-u", runAs, "/usr/bin/pkill", "-KILL", "-u", runAs], () => resolve());
      });
    } else if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Le groupe de processus est déjà terminé.
      }
    }
  }

  #environment(): Promise<Outcome> {
    const version = (command: string, args: string[]) =>
      new Promise<string>((resolve) => {
        execFile(command, args, { timeout: 5_000, env: safeEnv("/tmp") }, (error, stdout, stderr) =>
          resolve(error ? "absent" : ((stdout || stderr).trim().split(/\r?\n/)[0] ?? "")),
        );
      });
    return Promise.all([
      version("node", ["--version"]),
      version("npm", ["--version"]),
      version("python3", ["--version"]),
      version("git", ["--version"]),
    ]).then(([node, npm, python, git]) => ({
      ok: true,
      output: [
        "Système : linux (machine cloud de <br/>, 1 Go de mémoire)",
        "Interpréteur de commandes : /bin/sh",
        `Node : ${node}`,
        `npm : ${npm}`,
        `Python : ${python}`,
        `Git : ${git}`,
      ].join("\n"),
    }));
  }

  // --- Dossier de la commande

  async #prepare(
    orderId: string,
    space: string,
    repo: { fullName: string; token: string; author: { name: string; email: string } } | null,
  ): Promise<Outcome> {
    if (!UUID.test(orderId) || !UUID.test(space)) return refused("Commande invalide.");
    if (this.#orderId) await this.#cleanup(this.#orderId);
    const dir = join(this.#options.workRoot, space);
    const { runAs, spacesRoot } = this.#options;
    await this.#erase(homeOf(dir));
    await mkdir(homeOf(dir), { recursive: true });
    if (runAs) await chmod(homeOf(dir), 0o2770);
    await this.#erase(dir);

    if (!repo) {
      // L'espace du projet sort du coffre le temps de la commande : aucune autre n'y a accès.
      const stored = join(spacesRoot, space);
      const size = await sizeOf(stored);
      if (size > SPACE_LIMIT_BYTES) {
        return refused(
          `L'espace de ce projet est plein (${megabytes(size)} Mo sur ${megabytes(SPACE_LIMIT_BYTES)} Mo). Contactez l'équipe de <br/>.`,
        );
      }
      if (size >= 0) await rename(stored, dir);
      else await mkdir(dir, { recursive: true });
      if (runAs) await chmod(dir, 0o2770);
      this.#orderId = orderId;
      this.#dir = dir;
      this.#keep = stored;
      this.#token = null;
      return {
        ok: true,
        output:
          size >= SPACE_WARNING_BYTES
            ? `Espace du projet prêt, presque plein (${megabytes(size)} Mo) : retire ce qui ne sert plus.`
            : "Espace du projet prêt sur la machine cloud.",
      };
    }

    await mkdir(dir, { recursive: true });
    // Avec un compte séparé pour les commandes : groupe partagé, et sans droit de renommer `.git`.
    if (runAs) await chmod(dir, 0o3770);
    this.#orderId = orderId;
    this.#dir = dir;
    this.#keep = null;
    this.#token = repo.token;
    const base = this.#options.cloneBase ?? "https://github.com/";
    const cloned = await this.#git(dir, ["clone", `${base}${repo.fullName}.git`, "."], 300_000);
    if (cloned.code !== 0) return refused(`Clonage impossible : ${firstLines(cloned.stderr)}`);
    // Le compte des commandes n'entre pas dans `.git` : ni hooks, ni configuration à détourner.
    await chmod(join(dir, ".git"), 0o700);
    await this.#git(dir, ["config", "user.name", repo.author.name]);
    await this.#git(dir, ["config", "user.email", repo.author.email]);
    return { ok: true, output: `Dépôt ${repo.fullName} cloné sur la machine cloud.` };
  }

  /** Met le contenu du dossier dans un .zip et l'envoie au serveur. */
  async #collect(orderId: string, name: string): Promise<Outcome> {
    const root = this.#dir;
    if (!root || this.#orderId !== orderId) return refused("Le dossier de cette commande n'est pas prêt.");
    const files: Record<string, Uint8Array> = {};
    let count = 0;
    let total = 0;
    const walk = async (folder: string): Promise<void> => {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full);
          continue;
        }
        // Les liens symboliques ne sont pas rendus : ils pourraient viser n'importe quel fichier.
        if (!entry.isFile()) continue;
        const info = await lstat(full).catch(() => null);
        if (!info || total + info.size > MAX_ZIP_INPUT_BYTES) continue;
        const content = await readFile(full).catch(() => null);
        if (!content) continue;
        total += content.length;
        count++;
        files[relative(root, full).split(sep).join("/")] = content;
      }
    };
    await walk(root);
    const answer = (attachmentId: string | null, note: string): Outcome => ({
      ok: true,
      output: JSON.stringify({ attachmentId, files: count, note }),
    });
    if (count === 0) return answer(null, "Aucun fichier à envoyer dans l'espace du projet.");
    const zip = zipSync(files);
    if (zip.length > MAX_ZIP_BYTES) {
      return answer(
        null,
        `Le fichier .zip dépasse la limite (${megabytes(zip.length)} Mo sur ${megabytes(MAX_ZIP_BYTES)} Mo) : les fichiers restent dans l'espace du projet.`,
      );
    }
    const id = await this.#options.deliver(orderId, name, zip);
    return answer(id, `${count} fichier(s) envoyé(s) dans ${name} (${megabytes(zip.length)} Mo).`);
  }

  /** Fin de commande : l'espace du projet retourne au coffre ; un clone de dépôt est effacé. */
  async #cleanup(orderId: string): Promise<Outcome> {
    if (this.#orderId !== orderId) return { ok: true, output: "Rien à effacer." };
    const dir = this.#dir;
    if (dir) {
      if (this.#keep) await this.#store(dir, this.#keep);
      else await this.#erase(dir);
      await this.#erase(homeOf(dir));
    }
    this.#orderId = null;
    this.#dir = null;
    this.#keep = null;
    this.#token = null;
    return { ok: true, output: "Dossier de la commande rangé." };
  }

  /** Range un espace dans le coffre, sans les dossiers qu'une installation peut recréer. */
  async #store(dir: string, stored: string): Promise<void> {
    await this.#unlock(dir);
    for (const name of DISPOSABLE_DIRECTORIES) await rm(join(dir, name), { recursive: true, force: true });
    await rm(stored, { recursive: true, force: true });
    await rename(dir, stored);
  }

  /**
   * Après une coupure : les espaces restés dehors retournent au coffre, les clones de dépôts et
   * les dossiers personnels sont effacés.
   */
  async recover(): Promise<void> {
    const entries = await readdir(this.#options.workRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const dir = join(this.#options.workRoot, entry.name);
      if (UUID.test(entry.name) && entry.isDirectory() && !(await isClone(dir))) {
        await this.#store(dir, join(this.#options.spacesRoot, entry.name));
      } else {
        await this.#erase(dir);
      }
    }
  }

  /** Rend au travailleur ce que le compte des commandes a pu verrouiller pour lui seul. */
  async #unlock(dir: string): Promise<void> {
    const { runAs } = this.#options;
    if (runAs) {
      await new Promise<void>((resolve) => {
        execFile("sudo", ["-n", "-u", runAs, "/usr/bin/chmod", "-R", "ug+rwX", dir], () => resolve());
      });
    }
  }

  /** Efface un dossier, y compris ce que le compte des commandes y a verrouillé pour lui seul. */
  async #erase(dir: string): Promise<void> {
    await this.#unlock(dir);
    await rm(dir, { recursive: true, force: true });
  }

  // --- Git, seulement par le travailleur

  #git(cwd: string, args: string[], timeout = 120_000) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        {
          cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...safeEnv(this.#options.workRoot),
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: this.#options.askpass,
            ...(this.#token ? { BRIA_GIT_TOKEN: this.#token } : {}),
          },
        },
        (error, stdout, stderr) => {
          const failure = error as { code?: number | string } | null;
          resolve({
            code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
            stdout: String(stdout).trim(),
            stderr: String(stderr).trim(),
          });
        },
      );
    });
  }

  async #gitPrepare(root: string, branch: string, base: string): Promise<Outcome> {
    const fetched = await this.#git(root, ["fetch", "origin", "--prune"], 180_000);
    if (fetched.code !== 0)
      return refused(`Récupération depuis GitHub impossible : ${firstLines(fetched.stderr)}`);
    const verify = (ref: string) => this.#git(root, ["rev-parse", "--verify", "--quiet", ref]);
    if ((await verify(`refs/remotes/origin/${branch}`)).code === 0) {
      const resumed = await this.#git(root, ["checkout", "-B", branch, "--track", `origin/${branch}`]);
      if (resumed.code !== 0)
        return refused(`Reprise de ${branch} impossible : ${firstLines(resumed.stderr)}`);
      return { ok: true, output: `Branche ${branch} reprise depuis GitHub.` };
    }
    if ((await verify(`refs/remotes/origin/${base}`)).code !== 0) {
      return refused(`La branche principale « ${base} » est introuvable sur GitHub.`);
    }
    const created = await this.#git(root, ["checkout", "--no-track", "-b", branch, `origin/${base}`]);
    if (created.code !== 0)
      return refused(`Création de ${branch} impossible : ${firstLines(created.stderr)}`);
    return { ok: true, output: `Branche ${branch} créée depuis ${base}.` };
  }

  /** Commit au nom du demandeur, et push tout de suite : sur le cloud, le dossier va disparaître. */
  async #gitSave(root: string, branch: string, message: string): Promise<Outcome> {
    const current = await this.#git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current.stdout !== branch) return refused(`Le dossier n'est plus sur ${branch}.`);
    const added = await this.#git(root, ["add", "--all"]);
    if (added.code !== 0) return refused(`Préparation du commit impossible : ${firstLines(added.stderr)}`);
    const staged = await this.#git(root, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) {
      return result({ commit: null, pushed: false, note: "Aucun changement à enregistrer dans Git." });
    }
    const committed = await this.#git(root, ["commit", "-m", message], 180_000);
    if (committed.code !== 0)
      return refused(`Commit refusé : ${firstLines(committed.stderr || committed.stdout)}`);
    const sha = (await this.#git(root, ["rev-parse", "--short", "HEAD"])).stdout;
    const pushed = await this.#git(root, ["push", "--set-upstream", "origin", branch], 300_000);
    if (pushed.code !== 0) {
      return result({
        commit: sha,
        pushed: false,
        note: `Travail enregistré dans le commit ${sha} sur la branche \`${branch}\`, mais le push a échoué : ${firstLines(pushed.stderr)}`,
      });
    }
    return result({
      commit: sha,
      pushed: true,
      note: `Travail enregistré dans le commit ${sha} et poussé sur GitHub, branche \`${branch}\`.`,
    });
  }
}

const homeOf = (dir: string) => `${dir}-maison`;
const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1).replace(".0", "");

/** Taille d'un dossier en octets, sans suivre les liens ; -1 s'il n'existe pas. */
async function sizeOf(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return -1;
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += Math.max(0, await sizeOf(full));
    else if (entry.isFile()) total += (await lstat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** Vrai si le dossier est un clone de dépôt. */
const isClone = async (dir: string) => (await lstat(join(dir, ".git")).catch(() => null)) !== null;

const firstLines = (text: string) => text.split("\n").slice(0, 3).join(" ").slice(0, 400);

function result(value: { commit: string | null; pushed: boolean; note: string }): Outcome {
  return { ok: true, output: JSON.stringify(value) };
}
