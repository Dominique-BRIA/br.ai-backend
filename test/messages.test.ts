import type { ListMessagesResponse, Message, Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
let chef: { token: string; userId: string };
let ali: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  t = await startApp();
  chef = await t.signUp("chef@exemple.org", "Dominique");
  const team = (
    await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Équipe" } })
  ).json.team;
  const code = (
    await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })
  ).json.code;
  ali = await t.signUp("ali@exemple.org", "Ali", code);
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "Projet" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

const send = async (token: string, body: object) =>
  (await t.call<{ message: Message }>("POST", `/projects/${projectId}/messages`, { token, body })).json
    .message;

describe("messages", () => {
  it("enregistre l'auteur, la réponse et les mentions valables", async () => {
    const question = await send(chef.token, { body: "On part sur **PostgreSQL** ?" });
    expect(question.author).toEqual({ kind: "member", userId: chef.userId, displayName: "Dominique" });

    const answer = await send(ali.token, {
      body: "Oui, d'accord @Dominique",
      replyToId: question.id,
      mentions: [chef.userId, "00000000-0000-4000-8000-000000000000"],
    });
    expect(answer.replyTo).toMatchObject({ id: question.id, excerpt: "On part sur **PostgreSQL** ?" });
    expect(answer.mentions).toEqual([chef.userId]);
  });

  it("pagine l'historique du plus ancien au plus récent", async () => {
    for (let i = 1; i <= 5; i++) await send(chef.token, { body: `message ${i}` });

    const last = await t.call<ListMessagesResponse>("GET", `/projects/${projectId}/messages?limit=3`, {
      token: ali.token,
    });
    expect(last.json.messages.map((m) => m.body)).toEqual(["message 3", "message 4", "message 5"]);
    expect(last.json.hasMore).toBe(true);

    const before = last.json.messages[0]?.id;
    const older = await t.call<ListMessagesResponse>(
      "GET",
      `/projects/${projectId}/messages?limit=3&before=${before}`,
      { token: ali.token },
    );
    expect(older.json.messages.map((m) => m.body)).toEqual([
      "Oui, d'accord @Dominique",
      "message 1",
      "message 2",
    ]);
  });

  it("refuse un message vide et l'accès d'un non-membre", async () => {
    const empty = await t.call("POST", `/projects/${projectId}/messages`, {
      token: ali.token,
      body: { body: "  " },
    });
    expect(empty.status).toBe(400);

    const intrus = await t.signUp("intrus@exemple.org", "Intrus");
    const response = await t.call("GET", `/projects/${projectId}/messages`, { token: intrus.token });
    expect(response.status).toBe(404);
  });
});
