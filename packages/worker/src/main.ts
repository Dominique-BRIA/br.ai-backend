import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectWorker, deliverTo } from "./connection.ts";
import { CloudTools } from "./tools.ts";

/**
 * Point d'entrée de la machine cloud, lancé par systemd (voir installer.sh).
 * BRIA_SERVER_URL, BRIA_MACHINE_TOKEN : le serveur et le jeton donnés par l'administration.
 * BRIA_WORK_ROOT : dossier des commandes. BRIA_RUN_AS : compte Linux des commandes de l'IA.
 */
const serverUrl = process.env.BRIA_SERVER_URL;
const token = process.env.BRIA_MACHINE_TOKEN;
if (!serverUrl || !token) {
  console.error("BRIA_SERVER_URL et BRIA_MACHINE_TOKEN sont obligatoires.");
  process.exit(1);
}
// Hors de l'environnement du processus, pour que rien de ce qu'il lance n'en hérite.
delete process.env.BRIA_MACHINE_TOKEN;

const workRoot = process.env.BRIA_WORK_ROOT ?? "/srv/bria/travail";
const spacesRoot = process.env.BRIA_SPACES_ROOT ?? "/srv/bria/espaces";
const stateDir = process.env.BRIA_STATE_DIR ?? "/srv/bria/etat";
const runAs = process.env.BRIA_RUN_AS || undefined;
await mkdir(workRoot, { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(spacesRoot, { recursive: true });
// Le coffre des espaces : fermé au compte des commandes, qui ne voit que le projet en cours.
await chmod(spacesRoot, 0o700);
// Fichiers du travailleur modifiables par le groupe partagé avec le compte des commandes.
process.umask(0o002);

// Git demande le jeton à ce script, qui le lit dans l'environnement de cette seule commande Git.
const askpass = join(stateDir, "askpass.sh");
await writeFile(
  askpass,
  '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) echo "$BRIA_GIT_TOKEN" ;;\nesac\n',
);
await chmod(askpass, 0o700);

if (!runAs)
  console.error("BRIA_RUN_AS est absent : les commandes de l'IA ne sont pas isolées du travailleur.");

const tools = new CloudTools({
  workRoot,
  spacesRoot,
  askpass,
  runAs,
  deliver: deliverTo(serverUrl, token),
});
await tools.recover();

const connection = connectWorker({
  serverUrl,
  token,
  tools,
  log: {
    info: (text) => console.log(text),
    error: (text) => console.error(text),
  },
  onRefused: () => process.exit(1),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    connection.stop();
    process.exit(0);
  });
}
