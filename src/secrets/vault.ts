import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Chiffrement des secrets en AES-256-GCM. La clé maîtresse (32 octets, en base64) vient
 * des variables d'environnement du serveur et n'est jamais écrite en base.
 */
export class Vault {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("SECRETS_KEY doit contenir 32 octets encodés en base64.");
    this.#key = key;
  }

  seal(value: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  open(sealed: Sealed): string {
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
