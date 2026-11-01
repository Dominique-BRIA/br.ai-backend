import type { MaintenanceStatus } from "@br-ia/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.ts";

let t: TestApp;
let membre: { token: string; userId: string };
let equipeInterne: { token: string; userId: string };

beforeAll(async () => {
  t = await startApp();
  membre = await t.signUp("membre-maintenance@exemple.org", "Awa");
  equipeInterne = await t.signUp("interne@exemple.org", "Interne");
});
afterAll(() => t.stop());

const status = async (token?: string) =>
  (await t.call<{ maintenance: MaintenanceStatus }>("GET", "/status", token ? { token } : {})).json
    .maintenance;
const schedule = (startsAt: Date) =>
  t.call("PUT", "/admin/maintenance", {
    admin: true,
    body: {
      startsAt: startsAt.toISOString(),
      durationMinutes: 30,
      messageFr: "Mise à jour du serveur.",
      messageEn: "Server update.",
      exceptions: ["Interne@exemple.org"],
    },
  });

describe("mode maintenance", () => {
  it("annonce une maintenance programmée aux machines connectées et sur /status", async () => {
    expect((await status()).state).toBe("none");
    const machine = await t.live(membre.token);
    await machine.next("welcome");

    await schedule(new Date(Date.now() + 3_600_000));
    const event = await machine.next("platform.status");
    expect(event).toMatchObject({
      reopened: false,
      maintenance: { state: "scheduled", message: { fr: "Mise à jour du serveur." }, exempt: false },
    });
    expect((await status()).state).toBe("scheduled");
    // Avant l'heure, tout fonctionne.
    expect((await t.call("GET", "/workspace", { token: membre.token })).status).toBe(200);
    machine.socket.close();
  });

  it("pendant la maintenance, ferme l'accès sauf aux exceptions", async () => {
    await schedule(new Date(Date.now() - 60_000));
    const blocked = await t.call("GET", "/workspace", { token: membre.token });
    expect(blocked.status).toBe(503);
    expect(blocked.json).toMatchObject({ error: { code: "maintenance" } });

    expect((await t.call("GET", "/workspace", { token: equipeInterne.token })).status).toBe(200);
    expect(await status(equipeInterne.token)).toMatchObject({ state: "ongoing", exempt: true });
    expect(await status(membre.token)).toMatchObject({ state: "ongoing", exempt: false });
  });

  it("rouvre d'un clic et prévient les machines", async () => {
    const machine = await t.live(membre.token);
    await machine.next("welcome");
    await t.call("DELETE", "/admin/maintenance", { admin: true });
    expect(await machine.next("platform.status")).toMatchObject({
      reopened: true,
      maintenance: { state: "none" },
    });
    expect((await t.call("GET", "/workspace", { token: membre.token })).status).toBe(200);
    machine.socket.close();
  });
});
