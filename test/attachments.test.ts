import type { AttachmentResponse, Message, Team } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
let chef: { token: string; userId: string };
let ali: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  t = await startApp();
  chef = await t.signUp("chef@exemple.org", "Dominique");
  const team = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "É" } }))
    .json.team;
  const code = (
    await t.call<{ code: string }>("POST", `/teams/${team.id}/invitations`, { token: chef.token })
  ).json.code;
  ali = await t.signUp("ali@exemple.org", "Ali", code);
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "P" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

async function upload(token: string, content: Buffer, name: string, type = "text/plain") {
  const response = await t.app.inject({
    method: "POST",
    url: `/projects/${projectId}/attachments`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(name),
      "x-file-type": type,
    },
    payload: content,
  });
  return { status: response.statusCode, json: response.json() as AttachmentResponse };
}

describe("pièces jointes", () => {
  it("envoie un fichier, le joint à un message et le rend téléchargeable par l'équipe", async () => {
    const { json } = await upload(chef.token, Buffer.from("Bonjour l'équipe"), "notes de réunion.txt");
    expect(json.attachment).toMatchObject({
      name: "notes de réunion.txt",
      contentType: "text/plain",
      size: 17,
    });

    const sent = await t.call<{ message: Message }>("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { attachmentIds: [json.attachment.id] },
    });
    expect(sent.status).toBe(200);
    expect(sent.json.message.body).toBe("");
    expect(sent.json.message.attachments).toEqual([json.attachment]);

    const download = await t.app.inject({
      method: "GET",
      url: `/attachments/${json.attachment.id}`,
      headers: { authorization: `Bearer ${ali.token}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("Bonjour l'équipe");
    expect(download.headers["content-disposition"]).toContain("notes%20de%20r%C3%A9union.txt");

    // Une pièce déjà jointe ne peut pas l'être une seconde fois.
    const again = await t.call("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { body: "encore", attachmentIds: [json.attachment.id] },
    });
    expect(again.status).toBe(404);
  });

  it("refuse de joindre la pièce d'un autre membre, un message vide et un fichier trop gros", async () => {
    const { json } = await upload(ali.token, Buffer.from("x"), "a.txt");
    const stolen = await t.call("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { attachmentIds: [json.attachment.id] },
    });
    expect(stolen.status).toBe(404);

    const empty = await t.call("POST", `/projects/${projectId}/messages`, { token: chef.token, body: {} });
    expect(empty.status).toBe(400);

    const big = await upload(chef.token, Buffer.alloc(20 * 1024 * 1024 + 1), "gros.bin");
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ error: { code: "file_too_large" } });
  });

  it("nettoie le nom du fichier et refuse l'accès hors de l'équipe", async () => {
    const { json } = await upload(chef.token, Buffer.from("x"), "..\\..\\secret/../passwd");
    expect(json.attachment.name).toBe("passwd");

    const intrus = await t.signUp("intrus@exemple.org", "Intrus");
    const response = await t.app.inject({
      method: "GET",
      url: `/attachments/${json.attachment.id}`,
      headers: { authorization: `Bearer ${intrus.token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
