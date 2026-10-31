import { z } from "zod";

/**
 * Version du protocole entre l'extension et le serveur.
 * À augmenter à chaque changement incompatible des messages.
 */
export const PROTOCOL_VERSION = 1;

/** Chemin du point d'entrée WebSocket sur le serveur. */
export const WS_PATH = "/ws";

/** Délai laissé à l'extension pour se présenter après l'ouverture de la connexion. */
export const HELLO_TIMEOUT_MS = 10_000;

const machineInfo = z.object({
  /** Identifiant stable de la machine, généré par l'extension. */
  id: z.string().min(1).max(100),
  os: z.enum(["windows", "macos", "linux", "other"]),
  /** Éditeur hôte : VS Code, Cursor, Windsurf… */
  editor: z.string().max(100),
  editorVersion: z.string().max(50),
  extensionVersion: z.string().max(50),
});
export type MachineInfo = z.infer<typeof machineInfo>;

// Extension → serveur

const hello = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  machine: machineInfo,
});

const ping = z.object({
  type: z.literal("ping"),
  sentAt: z.number(),
});

export const clientMessage = z.discriminatedUnion("type", [hello, ping]);
export type ClientMessage = z.infer<typeof clientMessage>;

// Serveur → extension

const welcome = z.object({
  type: z.literal("welcome"),
  protocolVersion: z.number().int().positive(),
  serverVersion: z.string(),
  connectionId: z.string(),
});

const pong = z.object({
  type: z.literal("pong"),
  sentAt: z.number(),
});

export const errorCode = z.enum(["invalid_message", "hello_expected", "hello_timeout", "protocol_mismatch"]);
export type ErrorCode = z.infer<typeof errorCode>;

const error = z.object({
  type: z.literal("error"),
  code: errorCode,
  message: z.string(),
});

export const serverMessage = z.discriminatedUnion("type", [welcome, pong, error]);
export type ServerMessage = z.infer<typeof serverMessage>;

/** Lit un message reçu de l'extension. Renvoie `null` si le contenu est invalide. */
export function parseClientMessage(raw: string): ClientMessage | null {
  return parseJson(raw, clientMessage);
}

/** Lit un message reçu du serveur. Renvoie `null` si le contenu est invalide. */
export function parseServerMessage(raw: string): ServerMessage | null {
  return parseJson(raw, serverMessage);
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
