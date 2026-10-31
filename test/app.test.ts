import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage, WS_PATH } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/client.ts";
import { CLOSE_CODES } from "../src/ws/connection.ts";

const database = await openDatabase();
const app = await buildApp({ database, helloTimeoutMs: 200 });
let wsUrl = "";

beforeAll(async () => {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  wsUrl = `${address.replace("http", "ws")}${WS_PATH}`;
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const machine = {
  id: "machine-test",
  os: "windows",
  editor: "Visual Studio Code",
  editorVersion: "1.95.0",
  extensionVersion: "0.1.0",
} as const;

/** Ouvre une connexion et collecte les messages reçus jusqu'à la fermeture. */
function connect() {
  const socket = new WebSocket(wsUrl);
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => {
    const message = parseServerMessage(data.toString());
    if (message) messages.push(message);
  });
  const opened = new Promise<void>((resolve) => socket.once("open", () => resolve()));
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  const next = () =>
    new Promise<ServerMessage>((resolve) =>
      socket.once("message", (data) => resolve(parseServerMessage(data.toString()) as ServerMessage)),
    );
  return { socket, messages, opened, closed, next };
}

describe("GET /health", () => {
  it("indique que le serveur et la base fonctionnent", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", database: "ok" });
  });
});

describe("connexion WebSocket", () => {
  it("accueille une machine qui se présente, puis répond au ping", async () => {
    const client = connect();
    await client.opened;

    const welcome = client.next();
    client.socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, machine }));
    expect(await welcome).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION });

    const pong = client.next();
    client.socket.send(JSON.stringify({ type: "ping", sentAt: 42 }));
    expect(await pong).toEqual({ type: "pong", sentAt: 42 });

    client.socket.close();
    await client.closed;
  });

  it("refuse un premier message qui n'est pas « hello »", async () => {
    const client = connect();
    await client.opened;
    client.socket.send(JSON.stringify({ type: "ping", sentAt: 1 }));

    expect(await client.closed).toBe(CLOSE_CODES.protocolError);
    expect(client.messages[0]).toMatchObject({ type: "error", code: "hello_expected" });
  });

  it("refuse une version de protocole différente", async () => {
    const client = connect();
    await client.opened;
    client.socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1, machine }));

    expect(await client.closed).toBe(CLOSE_CODES.protocolMismatch);
    expect(client.messages[0]).toMatchObject({ type: "error", code: "protocol_mismatch" });
  });

  it("ferme la connexion si la machine ne se présente pas à temps", async () => {
    const client = connect();
    await client.opened;

    expect(await client.closed).toBe(CLOSE_CODES.helloTimeout);
    expect(client.messages[0]).toMatchObject({ type: "error", code: "hello_timeout" });
  });

  it("refuse un message illisible", async () => {
    const client = connect();
    await client.opened;
    client.socket.send("pas du JSON");

    expect(await client.closed).toBe(CLOSE_CODES.protocolError);
    expect(client.messages[0]).toMatchObject({ type: "error", code: "invalid_message" });
  });
});
