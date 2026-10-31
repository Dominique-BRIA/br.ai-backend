import { createHash, randomBytes, randomInt } from "node:crypto";

/** Jeton de session : 256 bits aléatoires. Seule son empreinte est stockée. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Code de connexion à 6 chiffres, envoyé par e-mail. */
export function newLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function loginCodeHash(email: string, code: string): string {
  return sha256(`${email}:${code}`);
}

// Alphabet sans caractères ambigus (0/O, 1/I/L).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Code d'invitation lisible, par exemple « EQP-7KQ2-M4XD ». */
export function newInvitationCode(prefix: string): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${prefix}-${part()}-${part()}`;
}

export function normalizeInvitationCode(code: string): string {
  return code.trim().toUpperCase();
}
