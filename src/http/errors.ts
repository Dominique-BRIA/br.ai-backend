import type { ApiError, ApiErrorCode } from "@br-ia/protocol";
import type { FastifyInstance } from "fastify";
import { ZodError, type z } from "zod";

/** Erreur prévue, renvoyée telle quelle au client. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = "Élément introuvable.") => new HttpError(404, "not_found", what);
export const forbidden = (why: string) => new HttpError(403, "forbidden", why);

/** Valide une entrée (corps, paramètres, requête) avec un schéma du protocole. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  return schema.parse(input);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send(body(error.code, error.message));
    }
    if (error instanceof ZodError) {
      return reply.code(400).send(body("invalid_request", "Requête invalide."));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send(body("invalid_request", "Requête invalide."));
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: "internal", message: "Erreur interne du serveur." } });
  });
}

function body(code: ApiErrorCode, message: string): ApiError {
  return { error: { code, message } };
}
