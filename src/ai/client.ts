import type { AppContext } from "../context.ts";
import { aiCalls } from "../db/schema.ts";

/**
 * Couche commune d'IA. Tous les fournisseurs utilisés (Gemini, Groq, Mistral,
 * OpenRouter… et Portkey s'il est ajouté plus tard) exposent la même interface,
 * compatible OpenAI : on essaie les modèles d'une chaîne dans l'ordre, et on passe
 * au suivant en cas de quota atteint, de panne ou de réponse inexploitable.
 */

export interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelChoice {
  provider: Provider;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  /** À quoi sert l'appel, pour la mesure de la consommation (« serveur », « cuisinier »…). */
  purpose: string;
  teamId?: string;
  projectId?: string;
  messages: ChatMessage[];
  /** Exige une réponse en JSON. */
  json?: boolean;
  /** Vérifie la réponse ; renvoyer faux fait passer au modèle suivant. */
  accept?: (content: string) => boolean;
}

export interface Completion {
  content: string;
  provider: string;
  model: string;
}

export class AiUnavailableError extends Error {}

const TIMEOUT_MS = 60_000;

/** Les fournisseurs connus et leur adresse compatible OpenAI. */
export const PROVIDER_URLS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export interface Ai {
  complete(chain: ModelChoice[], request: CompletionRequest): Promise<Completion>;
}

export class AiClient implements Ai {
  readonly #ctx: Pick<AppContext, "db" | "log">;
  readonly #fetch: typeof fetch;

  constructor(ctx: Pick<AppContext, "db" | "log">, fetchImpl: typeof fetch = fetch) {
    this.#ctx = ctx;
    this.#fetch = fetchImpl;
  }

  async complete(chain: ModelChoice[], request: CompletionRequest): Promise<Completion> {
    const failures: string[] = [];
    for (const choice of chain) {
      const started = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        const response = await this.#fetch(`${choice.provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${choice.provider.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: choice.model,
            messages: request.messages,
            ...(request.json && { response_format: { type: "json_object" } }),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        }
        const data = (await response.json()) as {
          choices?: { message?: { content?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        inputTokens = data.usage?.prompt_tokens ?? 0;
        outputTokens = data.usage?.completion_tokens ?? 0;
        const content = data.choices?.[0]?.message?.content?.trim() ?? "";
        if (!content) throw new Error("Réponse vide.");
        if (request.accept && !request.accept(content)) {
          // Un extrait va dans le journal du serveur pour comprendre le rejet, jamais dans la base.
          this.#ctx.log.debug({ model: choice.model, excerpt: content.slice(0, 300) }, "réponse IA rejetée");
          throw new Error("Réponse inexploitable.");
        }

        await this.#record(choice, request, started, inputTokens, outputTokens, null);
        return { content, provider: choice.provider.name, model: choice.model };
      } catch (error) {
        const message = (error as Error).message;
        failures.push(`${choice.provider.name}/${choice.model} : ${message}`);
        this.#ctx.log.warn(
          { provider: choice.provider.name, model: choice.model, error: message },
          "échec d'un appel IA",
        );
        await this.#record(choice, request, started, inputTokens, outputTokens, message);
      }
    }
    throw new AiUnavailableError(`Aucun modèle n'a répondu.\n${failures.join("\n")}`);
  }

  async #record(
    choice: ModelChoice,
    request: CompletionRequest,
    started: number,
    inputTokens: number,
    outputTokens: number,
    error: string | null,
  ): Promise<void> {
    await this.#ctx.db
      .insert(aiCalls)
      .values({
        purpose: request.purpose,
        teamId: request.teamId,
        projectId: request.projectId,
        provider: choice.provider.name,
        model: choice.model,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - started,
        ok: error === null,
        error: error?.slice(0, 500),
      })
      .catch((cause: unknown) => this.#ctx.log.error({ err: cause }, "appel IA non journalisé"));
  }
}

/**
 * Lit une chaîne de modèles écrite « fournisseur:modèle,fournisseur:modèle ».
 * Les fournisseurs sans clé sont ignorés.
 */
export function parseChain(spec: string, keys: Record<string, string | undefined>): ModelChoice[] {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf(":");
      const name = entry.slice(0, separator);
      const model = entry.slice(separator + 1);
      const apiKey = keys[name];
      const baseUrl = PROVIDER_URLS[name];
      return separator > 0 && model && apiKey && baseUrl
        ? [{ provider: { name, baseUrl, apiKey }, model }]
        : [];
    });
}
