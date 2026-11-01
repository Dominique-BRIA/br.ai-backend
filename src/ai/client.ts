import { createHash } from "node:crypto";
import type { AppContext } from "../context.ts";
import { aiCalls } from "../db/schema.ts";
import { afterAiUsage, creditRates, creditsFor } from "../services/credits.ts";

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

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

/** Outil proposé à l'IA (format « function » compatible OpenAI). */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface Accounting {
  /** À quoi sert l'appel, pour la mesure de la consommation (« serveur », « cuisinier »…). */
  purpose: string;
  teamId?: string;
  projectId?: string;
  /** Membre pour qui l'appel est fait (auteur du message, demandeur de la commande). */
  userId?: string;
}

export interface CompletionRequest extends Accounting {
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

export interface ToolTurnRequest extends Accounting {
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

/** Un tour de l'IA avec outils : du texte, des appels d'outils, ou les deux. */
export interface ToolTurn {
  content: string | null;
  toolCalls: ToolCall[];
  provider: string;
  model: string;
}

export class AiUnavailableError extends Error {}

const TIMEOUT_MS = 120_000;

/** Les fournisseurs connus et leur adresse compatible OpenAI. */
export const PROVIDER_URLS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  zai: "https://api.z.ai/api/paas/v4",
};

/** Délai minimal entre deux appels à un même fournisseur (offre gratuite de Mistral : 1 requête par seconde). */
const MIN_INTERVAL_MS: Record<string, number> = { mistral: 1_100 };

export interface Ai {
  complete(chain: ModelChoice[], request: CompletionRequest): Promise<Completion>;
  toolTurn(chain: ModelChoice[], request: ToolTurnRequest): Promise<ToolTurn>;
}

interface RawMessage {
  content?: string | null;
  tool_calls?: ToolCall[];
}

export class AiClient implements Ai {
  readonly #ctx: AppContext;
  readonly #fetch: typeof fetch;
  readonly #nextSlot = new Map<string, number>();
  /** Modèles dont le quota gratuit est épuisé, et jusqu'à quand on les laisse de côté. */
  readonly #pausedUntil = new Map<string, number>();

  constructor(ctx: AppContext, fetchImpl: typeof fetch = fetch) {
    this.#ctx = ctx;
    this.#fetch = fetchImpl;
  }

  async complete(chain: ModelChoice[], request: CompletionRequest): Promise<Completion> {
    return this.#firstSuccess(chain, request, async (choice) => {
      const message = await this.#call(choice, request, {
        messages: request.messages,
        ...(request.json && { response_format: { type: "json_object" } }),
      });
      const content = message.content?.trim() ?? "";
      if (!content) throw new Error("Réponse vide.");
      if (request.accept && !request.accept(content)) {
        // Un extrait va dans le journal du serveur pour comprendre le rejet, jamais dans la base.
        this.#ctx.log.debug({ model: choice.model, excerpt: content.slice(0, 300) }, "réponse IA rejetée");
        throw new Error("Réponse inexploitable.");
      }
      return { content, provider: choice.provider.name, model: choice.model };
    });
  }

  async toolTurn(chain: ModelChoice[], request: ToolTurnRequest): Promise<ToolTurn> {
    return this.#firstSuccess(chain, request, async (choice) => {
      const message = await this.#call(choice, request, {
        messages: messagesFor(choice.provider.name, request.messages),
        tools: request.tools,
        tool_choice: "auto",
      });
      const toolCalls = message.tool_calls ?? [];
      const content = message.content?.trim() || null;
      if (!content && toolCalls.length === 0) throw new Error("Réponse vide.");
      return { content, toolCalls, provider: choice.provider.name, model: choice.model };
    });
  }

  /** Essaie les modèles de la chaîne dans l'ordre jusqu'à une réponse exploitable. */
  async #firstSuccess<T>(
    chain: ModelChoice[],
    request: Accounting,
    run: (choice: ModelChoice) => Promise<T>,
  ) {
    const failures: string[] = [];
    // Un modèle au quota épuisé est sauté tant que sa pause dure, sauf si tous le sont.
    const ready = chain.filter((choice) => (this.#pausedUntil.get(keyOf(choice)) ?? 0) <= Date.now());
    for (const choice of ready.length > 0 ? ready : chain) {
      try {
        return await run(choice);
      } catch (error) {
        const message = (error as Error).message;
        failures.push(`${choice.provider.name}/${choice.model} : ${message}`);
        this.#ctx.log.warn(
          { provider: choice.provider.name, model: choice.model, purpose: request.purpose, error: message },
          "échec d'un appel IA",
        );
      }
    }
    throw new AiUnavailableError(`Aucun modèle n'a répondu.\n${failures.join("\n")}`);
  }

  /** Un appel HTTP, journalisé ; une limite de débit (429) est réessayée une fois après une pause. */
  async #call(choice: ModelChoice, request: Accounting, body: Record<string, unknown>): Promise<RawMessage> {
    for (let attempt = 1; ; attempt++) {
      await this.#waitTurn(choice.provider.name);
      const started = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        const response = await this.#fetch(`${choice.provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${choice.provider.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: choice.model, ...body }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status === 429 && attempt === 1) {
          await this.#record(choice, request, started, 0, 0, "HTTP 429 (nouvel essai)");
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          continue;
        }
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 429) this.#pause(choice, text, response.headers.get("retry-after"));
          throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
        }
        const data = (await response.json()) as {
          choices?: { message?: RawMessage }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        inputTokens = data.usage?.prompt_tokens ?? 0;
        outputTokens = data.usage?.completion_tokens ?? 0;
        await this.#record(choice, request, started, inputTokens, outputTokens, null);
        return data.choices?.[0]?.message ?? {};
      } catch (error) {
        await this.#record(choice, request, started, inputTokens, outputTokens, (error as Error).message);
        throw error;
      }
    }
  }

  /**
   * Met de côté un modèle qui refuse encore après le nouvel essai : le temps indiqué par le
   * fournisseur (« retryDelay » de Google, en-tête Retry-After), une minute sinon, dix au plus.
   */
  #pause(choice: ModelChoice, body: string, retryAfter: string | null): void {
    const seconds = Number(/"retryDelay"\s*:\s*"(\d+)/.exec(body)?.[1] ?? retryAfter ?? 60);
    const delay = Math.min(Number.isFinite(seconds) ? seconds : 60, 600) * 1000;
    this.#pausedUntil.set(keyOf(choice), Date.now() + delay);
  }

  async #waitTurn(provider: string): Promise<void> {
    const interval = MIN_INTERVAL_MS[provider] ?? 0;
    if (interval === 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.#nextSlot.get(provider) ?? 0);
    this.#nextSlot.set(provider, slot + interval);
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }

  async #record(
    choice: ModelChoice,
    request: Accounting,
    started: number,
    inputTokens: number,
    outputTokens: number,
    error: string | null,
  ): Promise<void> {
    try {
      const rates = await creditRates(this.#ctx);
      await this.#ctx.db.insert(aiCalls).values({
        purpose: request.purpose,
        teamId: request.teamId,
        projectId: request.projectId,
        userId: request.userId,
        provider: choice.provider.name,
        model: choice.model,
        inputTokens,
        outputTokens,
        credits: creditsFor(rates, choice.provider.name, choice.model, inputTokens, outputTokens),
        durationMs: Date.now() - started,
        ok: error === null,
        error: error?.slice(0, 500),
      });
      if (request.teamId && error === null) await afterAiUsage(this.#ctx, request.teamId, request.projectId);
    } catch (cause) {
      this.#ctx.log.error({ err: cause }, "appel IA non journalisé");
    }
  }
}

const keyOf = (choice: ModelChoice) => `${choice.provider.name}:${choice.model}`;

/**
 * L'historique tel que chaque fournisseur l'accepte. Gemini ajoute à ses appels d'outils des
 * champs à lui (extra_content, la signature de sa réflexion) qu'il veut retrouver tels quels ;
 * les autres fournisseurs les refusent. Mistral exige en plus des identifiants de 9 lettres ou
 * chiffres : les autres sont remplacés par une empreinte, la même pour l'appel et sa réponse.
 */
export function messagesFor(provider: string, messages: ChatMessage[]): ChatMessage[] {
  if (provider === "gemini") return messages;
  const id = (value: string) =>
    provider === "mistral" && !/^[a-zA-Z0-9]{9}$/.test(value)
      ? createHash("sha256").update(value).digest("hex").slice(0, 9)
      : value;
  return messages.map((message): ChatMessage => {
    if (message.role === "assistant" && message.tool_calls) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls.map((call) => ({
          id: id(call.id),
          type: "function",
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      };
    }
    if (message.role === "tool") return { ...message, tool_call_id: id(message.tool_call_id) };
    return message;
  });
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
