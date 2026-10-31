import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Rangement des fichiers (pièces jointes). Les clés sont générées par le serveur. */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** En développement : les fichiers sont écrits sur le disque. */
export class DiskStorage implements Storage {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.#path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  #path(key: string): string {
    const path = resolve(join(this.#root, key));
    if (!path.startsWith(this.#root)) throw new Error("Clé de stockage invalide.");
    return path;
  }
}

export interface B2Config {
  keyId: string;
  applicationKey: string;
  bucket: string;
  /** Par exemple https://s3.eu-central-003.backblazeb2.com */
  endpoint: string;
}

/** Backblaze B2, par son API compatible S3. Le compartiment reste privé : le serveur sert les fichiers. */
export class B2Storage implements Storage {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(config: B2Config) {
    // La région est la 2e partie de l'endpoint : s3.<region>.backblazeb2.com
    const region = config.endpoint.replace(/^https?:\/\//, "").split(".")[1] ?? "us-west-004";
    this.#s3 = new S3Client({
      region,
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.keyId, secretAccessKey: config.applicationKey },
    });
    this.#bucket = config.bucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.#s3.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!result.Body) throw new Error("Fichier vide dans le stockage.");
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}

/** Garde les fichiers en mémoire : pour les tests. */
export class MemoryStorage implements Storage {
  readonly files = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<void> {
    this.files.set(key, body);
  }

  async get(key: string): Promise<Buffer> {
    const file = this.files.get(key);
    if (!file) throw new Error("Fichier introuvable.");
    return file;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}
