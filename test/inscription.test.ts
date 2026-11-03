import type { Message, Project, Team, TeamUsage } from "@br-ia/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChain } from "../src/ai/client.ts";
import { aiCalls, creditGrants } from "../src/db/schema.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const ai = new ScriptedAi();
const chain = parseChain("gemini:faux", { gemini: "cle" });
let t: TestApp;

/** Comme en production : la formule d'essai ne donne aucun crédit. */
beforeAll(async () => {
  t = await startApp({ ai, serveurChain: chain, cuisinierChain: chain, essaiCredits: 0 });
});
afterAll(() => t.stop());

async function teamWithProject(token: string, name: string) {
  const team = (await t.call<{ team: Team }>("POST", "/teams", { token, body: { name } })).json.team;
  const project = (
    await t.call<{ project: Project }>("POST", `/teams/${team.id}/projects`, {
      token,
      body: { name: "Site" },
    })
  ).json.project;
  return { teamId: team.id, projectId: project.id };
}

const usage = async (token: string, teamId: string) =>
  (await t.call<TeamUsage>("GET", `/teams/${teamId}/usage`, { token })).json;

const redeem = (token: string, teamId: string, code: string) =>
  t.call("POST", `/teams/${teamId}/promo`, { token, body: { code } });

const history = async (token: string, projectId: string) =>
  (await t.call<{ messages: Message[] }>("GET", `/projects/${projectId}/messages?limit=50`, { token })).json
    .messages;

describe("inscription libre", () => {
  it("crée un compte sans code, mais l'IA reste éteinte jusqu'au code d'invitation", async () => {
    const answer = await t.call("POST", "/auth/code", { body: { email: "libre@exemple.org" } });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ newAccount: true });

    const chef = await t.signUp("chef@exemple.org", "Awa");
    const { teamId, projectId } = await teamWithProject(chef.token, "Sans crédit");
    expect(await usage(chef.token, teamId)).toMatchObject({ quota: 0, bonus: 0 });

    // Aucun appel à l'IA : la réponse préparée reste inutilisée, et le membre sait pourquoi.
    ai.replies.push({ category: "question", reply: "Réponse de l'IA.", memory: [] });
    const send = async (body: string) => {
      await t.call("POST", `/projects/${projectId}/messages`, { token: chef.token, body: { body } });
      await t.serveur?.idle();
    };
    const notices = async () =>
      (await history(chef.token, projectId)).filter((message) => message.body.includes("Crédit insuffisant"));

    await send("Bonjour tout le monde");
    expect(await notices()).toHaveLength(1);
    // Une discussion entre membres n'est pas interrompue à chaque message.
    await send("Vous êtes là ?");
    expect(await notices()).toHaveLength(1);
    // Une demande à l'agent reçoit toujours la réponse.
    await send("@bria écris-moi une page");
    expect(await notices()).toHaveLength(2);
    expect((await notices())[1]?.author.kind).toBe("serveur");
    expect(ai.replies).toHaveLength(1);

    // Le code active l'IA pour l'équipe.
    const code = await t.creditCode(1);
    expect((await redeem(chef.token, teamId, code)).status).toBe(200);
    expect(await usage(chef.token, teamId)).toMatchObject({ quota: 2000, bonus: 2000 });
    const grants = await t.db.select().from(creditGrants).where(eq(creditGrants.teamId, teamId));
    expect(grants.map((grant) => grant.credits)).toEqual([2000, 2000, 2000]);

    // Le montant est celui choisi à la création du code.
    const other = await t.signUp("montant@exemple.org", "Mia");
    const small = await teamWithProject(other.token, "Petit montant");
    await redeem(other.token, small.teamId, await t.creditCode(1, 500, 1));
    expect(await usage(other.token, small.teamId)).toMatchObject({ quota: 500, bonus: 500 });
    expect(new Set(grants.map((grant) => grant.month)).size).toBe(3);

    await t.call("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { body: "@bria et maintenant ?" },
    });
    await t.serveur?.idle();
    expect(ai.replies).toHaveLength(0);
    expect((await history(chef.token, projectId)).at(-1)?.body).toBe("Réponse de l'IA.");
  });

  it("coupe aussi l'IA quand les crédits sont épuisés", async () => {
    const chef = await t.signUp("epuise@exemple.org", "Eli");
    const { teamId, projectId } = await teamWithProject(chef.token, "Épuisée");
    await redeem(chef.token, teamId, await t.creditCode(1));
    await t.db.insert(aiCalls).values({
      teamId,
      projectId,
      userId: chef.userId,
      purpose: "essai",
      provider: "faux",
      model: "faux",
      inputTokens: 0,
      outputTokens: 0,
      credits: 2000,
      durationMs: 1,
      ok: true,
    });
    const before = ai.toolRequests.length;
    ai.replies.push({ category: "question", reply: "Ne doit pas partir.", memory: [] });
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { body: "@bria fais la page" },
    });
    await t.serveur?.idle();
    expect((await history(chef.token, projectId)).at(-1)?.body).toContain("Crédit insuffisant");
    expect(ai.replies).toHaveLength(1);
    expect(ai.toolRequests).toHaveLength(before);
    ai.replies.length = 0;
  });

  it("ne donne les crédits d'un code qu'une fois", async () => {
    const chef = await t.signUp("double@exemple.org", "Lou");
    const first = await teamWithProject(chef.token, "Première");
    const second = await teamWithProject(chef.token, "Seconde");
    const single = await t.creditCode(1);
    expect((await redeem(chef.token, first.teamId, single)).status).toBe(200);
    expect((await redeem(chef.token, second.teamId, single)).status).toBe(410);
    expect(await usage(chef.token, second.teamId)).toMatchObject({ quota: 0 });

    // Même un code à plusieurs utilisations ne sert qu'une fois par équipe.
    const shared = await t.creditCode(5);
    expect((await redeem(chef.token, second.teamId, shared)).status).toBe(200);
    expect((await redeem(chef.token, second.teamId, shared)).status).toBe(409);
    expect(await usage(chef.token, second.teamId)).toMatchObject({ quota: 2000 });
  });

  it("réserve la saisie du code au chef", async () => {
    const chef = await t.signUp("chef2@exemple.org", "Sam");
    const { teamId } = await teamWithProject(chef.token, "Équipe");
    const key = (
      await t.call<{ code: string }>("POST", `/teams/${teamId}/invitations`, { token: chef.token })
    ).json.code;
    const membre = await t.signUp("membre2@exemple.org", "Noa", key);
    expect((await redeem(membre.token, teamId, await t.creditCode(1))).status).toBe(403);
  });
});

describe("limite des nouveaux comptes", () => {
  it("bloque les créations en série depuis une même connexion, pas les comptes existants", async () => {
    const limited = await startApp({ newAccountCodesPerHour: 2, essaiCredits: 0 });
    try {
      const ask = (email: string, ip = "198.51.100.7:50000") =>
        limited.app.inject({
          method: "POST",
          url: "/auth/code",
          headers: { "x-forwarded-for": ip },
          payload: { email },
        });
      // Le premier compte finit son inscription : il existera pour la suite.
      const first = await ask("a@exemple.org");
      expect(first.statusCode).toBe(200);
      await limited.app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: {
          email: "a@exemple.org",
          code: limited.mailer.lastCodeFor("a@exemple.org"),
          machineId: "m",
          displayName: "A",
        },
      });
      expect((await ask("b@exemple.org")).statusCode).toBe(200);

      const blocked = await ask("c@exemple.org");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: "signup_limited" } });

      // Un début d'en-tête inventé ne contourne pas la limite.
      expect((await ask("d@exemple.org", "203.0.113.1, 198.51.100.7:50001")).statusCode).toBe(429);
      // Une autre connexion passe, et le compte existant n'est pas concerné par la limite.
      expect((await ask("e@exemple.org", "198.51.100.8:50000")).statusCode).toBe(200);
      expect((await ask("a@exemple.org")).json()).toMatchObject({ error: { code: "too_many_requests" } });
    } finally {
      await limited.stop();
    }
  });

  it("compte chaque visiteur du site à part, mais seulement avec la clé du site", async () => {
    const key = "cle-du-site-assez-longue-pour-le-test-0123456789";
    const limited = await startApp({ newAccountCodesPerHour: 1, essaiCredits: 0, siteRelayKey: key });
    try {
      // Les demandes du site arrivent toutes de la même adresse : celle du serveur du site.
      const fromSite = (email: string, visitor: string, siteKey = key) =>
        limited.app.inject({
          method: "POST",
          url: "/auth/code",
          headers: { "x-forwarded-for": "76.76.21.1", "x-bria-site-key": siteKey, "x-bria-visitor": visitor },
          payload: { email },
        });
      expect((await fromSite("v1@exemple.org", "203.0.113.10")).statusCode).toBe(200);
      expect((await fromSite("v2@exemple.org", "203.0.113.11")).statusCode).toBe(200);
      expect((await fromSite("v3@exemple.org", "203.0.113.10")).statusCode).toBe(429);
      // Sans la bonne clé, l'adresse transmise est ignorée : on retombe sur celle du site.
      expect((await fromSite("v4@exemple.org", "203.0.113.12", "fausse-cle")).statusCode).toBe(200);
      expect((await fromSite("v5@exemple.org", "203.0.113.13", "fausse-cle")).statusCode).toBe(429);
    } finally {
      await limited.stop();
    }
  });
});
