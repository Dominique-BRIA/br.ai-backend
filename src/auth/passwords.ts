import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Paramètres scrypt (coût N, taille de bloc r, parallélisme p) et longueur de la clé dérivée.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );

/** Empreinte d'un mot de passe : « scrypt$N$r$p$sel$clé », sel et clé en base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Vrai si le mot de passe correspond à l'empreinte (comparaison en temps constant). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
