import type { Ai, CompletionRequest, ModelChoice, ToolCall, ToolTurnRequest } from "../src/ai/client.ts";
import { AiUnavailableError } from "../src/ai/client.ts";

/** Un tour du faux cuisinier : du texte et/ou des appels d'outils. */
export interface ScriptedTurn {
  content?: string;
  calls?: { name: string; input: object }[];
}

/** Fausse IA : renvoie les réponses prévues, dans l'ordre, et garde les demandes reçues. */
export class ScriptedAi implements Ai {
  readonly requests: CompletionRequest[] = [];
  readonly replies: (object | "indisponible")[] = [];
  readonly toolRequests: ToolTurnRequest[] = [];
  readonly turns: (ScriptedTurn | "indisponible")[] = [];
  #nextId = 1;

  async complete(_chain: ModelChoice[], request: CompletionRequest) {
    this.requests.push(request);
    const next = this.replies.shift();
    if (!next || next === "indisponible") throw new AiUnavailableError("aucun modèle");
    const content = JSON.stringify(next);
    if (request.accept && !request.accept(content)) throw new AiUnavailableError("réponse refusée");
    return { content, provider: "faux", model: "faux" };
  }

  async toolTurn(_chain: ModelChoice[], request: ToolTurnRequest) {
    // Copie : la boucle du cuisinier continue d'ajouter des messages au même tableau.
    this.toolRequests.push({ ...request, messages: [...request.messages] });
    const next = this.turns.shift();
    if (!next || next === "indisponible") throw new AiUnavailableError("aucun modèle");
    const toolCalls: ToolCall[] = (next.calls ?? []).map((call) => ({
      id: `appel${this.#nextId++}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    }));
    return { content: next.content ?? null, toolCalls, provider: "faux", model: "faux" };
  }
}
