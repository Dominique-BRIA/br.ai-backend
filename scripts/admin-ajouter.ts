/**
 * Ajoute un compte de l'équipe interne au tableau de bord d'administration.
 *
 *   npm run admin:ajouter
 *
 * Le script demande l'adresse, le nom et le mot de passe (saisi sans être affiché), puis les
 * envoie au serveur en cours d'exécution, authentifié par le jeton ADMIN_TOKEN du fichier .env.
 */
import { createInterface } from "node:readline";

const server = (process.env.ADMIN_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`).replace(
  /\/+$/,
  "",
);
const token = process.env.ADMIN_TOKEN;

/** Pose une question ; avec `hidden`, chaque caractère tapé s'affiche comme une étoile. */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const output = rl as unknown as { _writeToOutput: (text: string) => void };
      const write = output._writeToOutput.bind(rl);
      output._writeToOutput = (text: string) => write(text.includes(question) ? text : "*");
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

if (!token) {
  console.error("ADMIN_TOKEN manque dans le fichier .env du serveur.");
  process.exit(1);
}

const email = await ask("Adresse e-mail : ");
const name = await ask("Nom affiché : ");
const password = await ask("Mot de passe (12 caractères au moins) : ", true);
const confirmation = await ask("Confirmez le mot de passe : ", true);
if (password !== confirmation) {
  console.error("Les deux mots de passe ne correspondent pas.");
  process.exit(1);
}

const response = await fetch(`${server}/admin/admins`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-admin-token": token },
  body: JSON.stringify({ email, name, password }),
}).catch(() => null);
if (!response) {
  console.error(`Le serveur ne répond pas sur ${server}. Lancez-le d'abord (npm run dev).`);
  process.exit(1);
}
if (!response.ok) {
  const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  console.error(`Refusé : ${json.error?.message ?? response.status}`);
  process.exit(1);
}
console.log(`Compte créé pour ${email}. Connectez-vous sur la page /admin du site.`);
