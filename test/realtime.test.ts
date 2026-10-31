import { PROTOCOL_VERSION, type Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLOSE_CODES } from "../src/ws/connection.ts";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.stop());

describe("santé", () => {
  it("indique que le serveur et la base fonctionnent", async () => {
    const response = await t.call("GET", "/health");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "ok", database: "ok" });
  });
});

describe("connexion temps réel", () => {
  /** Envoie un premier message brut et attend la fermeture. */
  async function rawFirstMessage(payload: string) {
    const socket = new WebSocket(t.wsUrl);
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    if (payload) socket.send(payload);
    return { code: await closed, first: JSON.parse(messages[0] ?? "{}") };
  }

  const machine = {
    id: "m",
    os: "linux",
    editor: "VS Code",
    editorVersion: "1.95.0",
    extensionVersion: "0.2.0",
  };

  it("refuse un jeton inconnu", async () => {
    const result = await rawFirstMessage(
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, token: "inconnu", machine }),
    );
    expect(result.code).toBe(CLOSE_CODES.unauthenticated);
    expect(result.first).toMatchObject({ type: "error", code: "unauthenticated" });
  });

  it("refuse une autre version du protocole", async () => {
    const result = await rawFirstMessage(
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1, token: "x", machine }),
    );
    expect(result.code).toBe(CLOSE_CODES.protocolMismatch);
  });

  it("refuse un premier message qui n'est pas « hello », un message illisible et le silence", async () => {
    expect((await rawFirstMessage(JSON.stringify({ type: "ping", sentAt: 1 }))).first).toMatchObject({
      code: "hello_expected",
    });
    expect((await rawFirstMessage("pas du JSON")).first).toMatchObject({ code: "invalid_message" });
    expect((await rawFirstMessage("")).code).toBe(CLOSE_CODES.helloTimeout);
  });

  it("annonce la présence et diffuse les messages aux membres de l'équipe", async () => {
    const chef = await t.signUp("chef@exemple.org", "Dominique");
    const team = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "É" } }))
      .json.team;
    const code = (
      await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })
    ).json.code;
    const ali = await t.signUp("ali@exemple.org", "Ali", code);
    const project = (
      await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
        token: chef.token,
        body: { name: "P" },
      })
    ).json.project;

    const chefLive = await t.live(chef.token);
    await chefLive.next("welcome");

    const aliLive = await t.live(ali.token);
    await aliLive.next("welcome");
    expect(await chefLive.next("presence.changed")).toEqual({
      type: "presence.changed",
      userId: ali.userId,
      online: true,
    });
    expect(
      (await t.workspace(chef.token)).teams[0]?.members.find((m) => m.userId === ali.userId)?.online,
    ).toBe(true);

    await t.call("POST", `/projects/${project.id}/messages`, { token: ali.token, body: { body: "Salut" } });
    const received = await chefLive.next("message.created");
    expect(received.message).toMatchObject({ body: "Salut", author: { displayName: "Ali" } });

    aliLive.socket.close();
    expect(await chefLive.next("presence.changed")).toMatchObject({ userId: ali.userId, online: false });

    // Une invitation acceptée prévient les membres de recharger l'espace de travail.
    const fatou = await t.signUp("fatou@exemple.org", "Fatou");
    await t.call("POST", "/invitations/accept", { token: fatou.token, body: { code } });
    expect(await chefLive.next("workspace.changed")).toEqual({ type: "workspace.changed" });

    chefLive.socket.close();
  });
});
