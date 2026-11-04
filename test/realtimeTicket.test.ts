import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage, type Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.stop());

const browser = {
  id: "web-navigateur",
  os: "other" as const,
  editor: "Navigateur",
  editorVersion: "web",
  extensionVersion: "web",
};

/** Ouvre une connexion comme le ferait la plateforme web, et renvoie le premier message reçu. */
async function connect(ticket: string) {
  const socket = new WebSocket(t.wsUrl);
  const messages: ServerMessage[] = [];
  const first = new Promise<ServerMessage>((resolve) => {
    socket.on("message", (data) => {
      const message = parseServerMessage(data.toString());
      if (!message) return;
      messages.push(message);
      if (messages.length === 1) resolve(message);
    });
  });
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, ticket, machine: browser }));
  return { socket, first: await first, messages };
}

const ticketFor = async (token: string) =>
  (await t.call<{ ticket: string }>("POST", "/realtime/ticket", { token })).json.ticket;

describe("tickets de connexion temps réel", () => {
  it("ouvre la connexion du navigateur une seule fois, puis livre les messages", async () => {
    const ali = await t.signUp("ali-web@exemple.org", "Ali");
    expect((await t.call("POST", "/realtime/ticket")).status).toBe(401);

    const ticket = await ticketFor(ali.token);
    const opened = await connect(ticket);
    expect(opened.first.type).toBe("welcome");

    // Le même ticket ne rouvre rien.
    const reused = await connect(ticket);
    expect(reused.first).toMatchObject({ type: "error", code: "unauthenticated" });

    // La connexion reçoit les messages de ses projets, comme l'extension.
    const team = (await t.call<{ team: Team }>("POST", "/teams", { token: ali.token, body: { name: "Web" } }))
      .json.team;
    const project = (
      await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
        token: ali.token,
        body: { name: "Site" },
      })
    ).json.project;
    await t.call("POST", `/projects/${project.id}/messages`, { token: ali.token, body: { body: "Bonjour" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(opened.messages.some((message) => message.type === "message.created")).toBe(true);

    // La session apparaît comme un navigateur dans la liste des machines.
    const { json } = await t.call<{ sessions: { editor: string | null; online: boolean }[] }>(
      "GET",
      "/me/sessions",
      { token: ali.token },
    );
    expect(json.sessions.find((session) => session.editor === "Navigateur")?.online).toBe(true);
    opened.socket.close();
    reused.socket.close();
  });

  it("refuse un ticket inventé ou celui d'une session fermée", async () => {
    const fatou = await t.signUp("fatou-web@exemple.org", "Fatou");
    expect((await connect("ticket-invente")).first).toMatchObject({ type: "error", code: "unauthenticated" });

    const ticket = await ticketFor(fatou.token);
    await t.call("POST", "/auth/logout", { token: fatou.token });
    const closed = await connect(ticket);
    expect(closed.first).toMatchObject({ type: "error", code: "unauthenticated" });
    closed.socket.close();
  });
});
