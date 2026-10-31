// Lance le programme esbuild natif, sans passer par son interface JavaScript.
//
// Dans certains environnements Windows, les processus lancés par Node se terminent
// parfois avec un code anormal (259, ou aucun code) alors qu'esbuild n'a rien signalé :
// l'interface JavaScript d'esbuild s'arrête alors au hasard (« The service was stopped »).
// On appelle donc le programme directement, et on réessaie dans ce seul cas.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
const binary = require.resolve(
  process.platform === "win32" ? `${platformPackage}/esbuild.exe` : `${platformPackage}/bin/esbuild`,
);

const ABNORMAL_EXIT = new Set([null, 259]);
const ATTEMPTS = 3;

function once(args) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: "inherit" });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code));
  });
}

/** Exécute esbuild avec ces arguments ; rejette si la construction échoue. */
export async function esbuild(args) {
  for (let attempt = 1; ; attempt++) {
    const code = await once(args);
    if (code === 0) return;
    if (!ABNORMAL_EXIT.has(code) || attempt === ATTEMPTS) {
      throw new Error(`esbuild a échoué (code ${code})`);
    }
  }
}
