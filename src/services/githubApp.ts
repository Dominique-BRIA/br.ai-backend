import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";

export interface GitHubAppSettings {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** Clé privée de l'application, au format PEM. */
  privateKey: string;
  webhookSecret: string;
}

export interface ServerMerge {
  number: number;
  url: string;
  merged: boolean;
  reason: string | null;
}

/** Le lien vers l'installation reste valable une heure. */
const STATE_LIFETIME_S = 3600;

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * L'application GitHub de <br/>, facultative (F-GIT-10) : avec elle, le serveur ouvre et fusionne
 * les pull requests sans machine allumée, et il apprend les fusions faites sur GitHub. Sans elle,
 * tout passe par la connexion GitHub de chaque membre dans VS Code.
 */
export class GitHubApp {
  readonly #settings: GitHubAppSettings;
  readonly #fetch: typeof fetch;

  constructor(settings: GitHubAppSettings, fetchImpl: typeof fetch = fetch) {
    this.#settings = settings;
    this.#fetch = fetchImpl;
  }

  /** Page d'installation de GitHub ; GitHub revient ensuite sur /github/callback avec `state`. */
  installUrl(state: string): string {
    return `https://github.com/apps/${this.#settings.slug}/installations/new?state=${state}`;
  }

  /** Lie le retour de GitHub au projet et au chef qui a demandé l'installation. */
  signState(projectId: string, userId: string, now = Date.now()): string {
    const payload = `${projectId}.${userId}.${Math.floor(now / 1000) + STATE_LIFETIME_S}`;
    return `${payload}.${this.#hmac(`state:${payload}`)}`;
  }

  readState(state: string, now = Date.now()): { projectId: string; userId: string } | null {
    const [projectId, userId, expires, signature] = state.split(".");
    if (!projectId || !userId || !expires || !signature) return null;
    if (!sameText(signature, this.#hmac(`state:${projectId}.${userId}.${expires}`))) return null;
    if (Number(expires) < now / 1000) return null;
    return { projectId, userId };
  }

  /** Vérifie qu'un webhook vient bien de GitHub (en-tête x-hub-signature-256). */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac("sha256", this.#settings.webhookSecret).update(rawBody).digest("hex");
    return sameText(signature, `sha256=${expected}`);
  }

  /**
   * Le compte GitHub qui revient de l'installation peut-il écrire dans ce dépôt ? Le serveur
   * fusionnera avec les droits de l'application : sans cette preuve, une équipe pourrait brancher
   * le dépôt d'une autre et y faire fusionner une branche. Le jeton sert ici puis est oublié.
   */
  async userCanPush(code: string, fullName: string): Promise<boolean> {
    const exchange = await this.#fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.#settings.clientId,
        client_secret: this.#settings.clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const { access_token: token } = (await exchange.json().catch(() => ({}))) as { access_token?: string };
    if (!token) return false;
    const { ok, json } = await this.#api("GET", `/repos/${fullName}`, token);
    return ok && (json as { permissions?: { push?: boolean } }).permissions?.push === true;
  }

  /** Numéro de l'installation de l'application sur ce dépôt, s'il y en a une. */
  async installationFor(fullName: string): Promise<number | null> {
    const { ok, json } = await this.#api("GET", `/repos/${fullName}/installation`, this.#appToken());
    return ok ? (json as { id: number }).id : null;
  }

  /** Ouvre la pull request (ou reprend celle qui existe) et la fusionne au nom de l'application. */
  async mergeBranch(
    installationId: number,
    fullName: string,
    change: { branch: string; base: string; title: string; body: string },
  ): Promise<ServerMerge> {
    const access = await this.#api(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      this.#appToken(),
    );
    const token = (access.json as { token?: string }).token;
    if (!access.ok || !token) throw new Error(`Accès GitHub refusé (${access.status}).`);
    const repo = `/repos/${fullName}`;
    const owner = fullName.split("/")[0];
    const found = await this.#api(
      "GET",
      `${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(change.branch)}`,
      token,
    );
    if (!found.ok) throw new Error(`GitHub a refusé : ${message(found)}`);
    let pull = (found.json as unknown as PullRequest[]).find(
      (item) => item.state === "open" || item.merged_at,
    );
    if (!pull) {
      const created = await this.#api("POST", `${repo}/pulls`, token, {
        title: change.title,
        head: change.branch,
        base: change.base,
        body: change.body,
      });
      if (!created.ok) throw new Error(`GitHub a refusé : ${message(created)}`);
      pull = created.json as unknown as PullRequest;
    }
    const opened = { number: pull.number, url: pull.html_url };
    if (pull.merged_at) return { ...opened, merged: true, reason: null };

    // Tous les dépôts n'autorisent pas la même méthode de fusion.
    let reason = "";
    for (const method of ["merge", "squash", "rebase"]) {
      const merge = await this.#api("PUT", `${repo}/pulls/${pull.number}/merge`, token, {
        merge_method: method,
      });
      if (merge.ok) return { ...opened, merged: true, reason: null };
      reason = message(merge);
      if (merge.status !== 405 || !/not allowed/i.test(reason)) break;
    }
    return { ...opened, merged: false, reason };
  }

  #hmac(text: string): string {
    return createHmac("sha256", this.#settings.webhookSecret).update(text).digest("base64url");
  }

  /** Jeton de l'application elle-même, signé avec sa clé privée, valable quelques minutes. */
  #appToken(): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const content = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iat: now - 60,
      exp: now + 540,
      iss: this.#settings.appId,
    })}`;
    const signature = createSign("RSA-SHA256").update(content).sign(this.#settings.privateKey, "base64url");
    return `${content}.${signature}`;
  }

  async #api(method: string, path: string, token: string, body?: unknown) {
    const response = await this.#fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, status: response.status, json };
  }
}

interface PullRequest {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
}

const message = (answer: { status: number; json: Record<string, unknown> }) =>
  String(answer.json.message ?? answer.status);

/** L'application, si toutes ses variables sont là ; `null` sinon : elle reste facultative. */
export function githubAppFrom(config: Config): GitHubApp | null {
  const {
    GITHUB_APP_ID: appId,
    GITHUB_APP_SLUG: slug,
    GITHUB_APP_CLIENT_ID: clientId,
    GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
  } = config;
  const privateKey =
    config.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
    (config.GITHUB_APP_PRIVATE_KEY_PATH && readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8"));
  if (!appId || !slug || !clientId || !clientSecret || !webhookSecret || !privateKey) return null;
  return new GitHubApp({ appId, slug, clientId, clientSecret, webhookSecret, privateKey });
}
