import {
  type Message,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ServerMessage,
  type Workspace,
  WS_PATH,
} from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { type AppOptions, buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/client.ts";
import { plans } from "../src/db/schema.ts";
import type { Mail, Mailer } from "../src/mail/mailer.ts";

export const ADMIN_TOKEN = "jeton-admin-de-test-0123456789";

/** Garde les e-mails envoyés pour retrouver les codes de connexion. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  /** Nombre de prochains envois qui échoueront, comme un refus du service d'e-mail. */
  failNext = 0;
  async send(mail: Mail) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Envoi refusé (test)");
    }
    this.sent.push(mail);
  }
  lastCodeFor(email: string): string {
    const mail = this.sent.findLast((candidate) => candidate.to === email);
    const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`Aucun code envoyé à ${email}`);
    return code;
  }
}

export async function startApp(
  options: Pick<
    AppOptions,
    "ai" | "serveurChain" | "cuisinierChain" | "vault" | "githubApp" | "newAccountCodesPerHour"
  > & {
    /** Crédits mensuels de la formule d'essai : les tests partent d'une équipe qui peut utiliser l'IA. */
    essaiCredits?: number;
  } = {},
) {
  const database = await openDatabase();
  const mailer = new MemoryMailer();
  const { app, ctx, serveur, kitchen } = await buildApp({
    database,
    mailer,
    adminToken: ADMIN_TOKEN,
    helloTimeoutMs: 300,
    newAccountCodesPerHour: Number.POSITIVE_INFINITY,
    ...options,
  });
  await database.db
    .update(plans)
    .set({ monthlyCredits: options.essaiCredits ?? 2000 })
    .where(eq(plans.id, "essai"));
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const wsUrl = `${address.replace("http", "ws")}${WS_PATH}`;

  async function call<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    options: { token?: string; body?: unknown; admin?: boolean } = {},
  ): Promise<{ status: number; json: T }> {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(options.token && { authorization: `Bearer ${options.token}` }),
        ...(options.admin && { "x-admin-token": ADMIN_TOKEN }),
      },
      ...(options.body !== undefined && { payload: options.body as object }),
    });
    return { status: response.statusCode, json: response.body ? response.json() : (undefined as T) };
  }

  /** Un code de crédits, créé comme dans le tableau de bord. */
  async function creditCode(maxUses = 10, credits = 2000, durationMonths = 3): Promise<string> {
    const { json } = await call<{ codes: string[] }>("POST", "/admin/promo-codes", {
      admin: true,
      body: { kind: "credits", credits, durationMonths, maxUses },
    });
    return String(json.codes[0]);
  }

  /** Crée un compte ; avec une clé d'équipe, il rejoint aussi cette équipe. */
  async function signUp(email: string, displayName: string, teamKey?: string) {
    await call("POST", "/auth/code", { body: { email } });
    const { json } = await call<{ token: string; user: { id: string } }>("POST", "/auth/verify", {
      body: { email, code: mailer.lastCodeFor(email), machineId: `machine-${email}`, displayName },
    });
    if (teamKey) await call("POST", "/invitations/accept", { token: json.token, body: { code: teamKey } });
    return { token: json.token, userId: json.user.id };
  }

  async function workspace(token: string) {
    return (await call<Workspace>("GET", "/workspace", { token })).json;
  }

  /** Ouvre une connexion temps réel authentifiée et collecte les événements reçus. */
  async function live(token: string) {
    const socket = new WebSocket(wsUrl);
    const received: ServerMessage[] = [];
    const waiters: { test: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    socket.on("message", (data) => {
      const message = parseServerMessage(data.toString());
      if (!message) return;
      // Un message attendu est remis à son destinataire ; les autres sont gardés pour plus tard.
      const waiter = waiters.find((candidate) => candidate.test(message));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        received.push(message);
      }
    });
    const next = <T extends ServerMessage["type"]>(type: T) =>
      new Promise<Extract<ServerMessage, { type: T }>>((resolve) => {
        const already = received.find((m) => m.type === type);
        if (already) {
          received.splice(received.indexOf(already), 1);
          resolve(already as Extract<ServerMessage, { type: T }>);
          return;
        }
        waiters.push({ test: (m) => m.type === type, resolve: resolve as (m: ServerMessage) => void });
      });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token,
        machine: {
          id: "m",
          os: "windows",
          editor: "Visual Studio Code",
          editorVersion: "1.95.0",
          extensionVersion: "0.2.0",
        },
      }),
    );
    return { socket, received, next, closed };
  }

  async function stop() {
    await app.close();
    await database.close();
  }

  return {
    app,
    ctx,
    serveur,
    kitchen,
    db: database.db,
    mailer,
    wsUrl,
    call,
    creditCode,
    signUp,
    workspace,
    live,
    stop,
  };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;
export type { Message };
