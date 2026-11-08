import type { MemoryItem, Message, Order, TeamRole } from "@br-ia/protocol";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { type Ai, AiUnavailableError, type ChatMessage, type ModelChoice } from "../ai/client.ts";
import type { AppContext, CatchUpRequest } from "../context.ts";
import { messages, teamMembers, users } from "../db/schema.ts";
import { quotaReached } from "../services/credits.ts";
import { addMemory, announceMemoryChange, listMemory, setMemoryStatus } from "../services/memory.ts";
import { postAgentMessage, toMessages } from "../services/messages.ts";
import type { Kitchen } from "./cuisinier.ts";

/** Sans mention de l'agent, le manque de crédit n'est rappelé qu'une fois par jour dans un projet. */
const CREDIT_NOTICE_INTERVAL_MS = 24 * 60 * 60_000;

/** Nombre de messages récents donnés à l'agent comme contexte. */
const HISTORY = 30;

/** Un message s'adresse explicitement à l'agent quand il contient « @bria ». */
export const BRIA_MENTION = /(^|[^\w@])@bria\b/i;

const output = z.object({
  category: z.enum(["discussion", "question", "decision", "contradiction", "request"]),
  reply: z.string().trim().max(4000).nullable(),
  memory: z
    .array(
      z.discriminatedUnion("op", [
        z.object({
          op: z.literal("add"),
          type: z.enum(["decision", "question", "task", "compromise"]),
          text: z.string().trim().min(1).max(500),
        }),
        z.object({
          op: z.literal("resolve"),
          ref: z.string(),
          status: z.enum(["resolved", "stopped"]).default("resolved"),
        }),
      ]),
    )
    .default([]),
  /** Commande à passer au cuisinier, quand la demande est assez précise. */
  order: z
    .object({
      title: z.string().trim().min(1).max(120),
      brief: z.string().trim().min(1).max(6000),
      /** Numéro de la commande que cette demande prolonge ; absent : une nouvelle commande. */
      continues: z.number().int().positive().nullable().optional(),
    })
    .nullable()
    .default(null),
  /** Préférence de travail personnelle de l'auteur, à garder sur ses machines. */
  preference: z.string().trim().min(1).max(300).nullable().default(null),
});
export type ServeurOutput = z.infer<typeof output>;

/** Résumé d'absence : en dessous de ce nombre de messages, la liste suffit. */
export const CATCH_UP_MIN_MESSAGES = 3;

const CATCH_UP_PROMPT = `Tu es le serveur de <br/>, l'agent présent dans le chat d'une équipe.
Un membre revient après plusieurs heures d'absence. Résume-lui ce qui s'est passé dans le chat pendant ce temps, en t'adressant à lui.

- 3 à 6 puces au plus, en Markdown, dans la langue des messages.
- D'abord ce qui le concerne : les questions qu'on lui a posées, les mentions, ce qu'on attend de lui.
- Puis les décisions prises, les commandes passées au cuisinier et leur résultat, les désaccords en cours.
- Cite les auteurs par leur prénom. N'invente rien ; ne recopie pas les messages.
- Ton de collègue, sans emoji ni point d'exclamation. Pas de titre ni de formule d'introduction.`;

const WORK_PROMISE =
  /\bj['’]ajoute\b|\bje m['’]en occupe\b|\bje\s+(?:l['’]|la\s+|le\s+|les\s+)?(?:transmets|lance|ajoute|corrige|modifie|crée|génère|passe la commande)\b/i;
const KEEP_PROMISE = `Ta réponse annonce un travail, mais "order" est vide : le cuisinier ne recevra rien. Renvoie le même objet JSON corrigé : remplis "order" (avec "continues" si cela prolonge une commande récente). Si le travail est impossible sans une précision, garde "order" à null et pose la question ; s'il ne s'agit pas d'un travail, reformule sans rien annoncer.`;
const ORDER_NOT_SENT =
  "Je n'ai pas réussi à transmettre cette demande au cuisinier. Dans l'onglet Commandes, utilisez « Demander une suite » sur la commande concernée, ou passez une nouvelle commande.";

/** La réponse annonce un travail sans commande derrière : sans correction, il ne se passerait rien. */
function promisesWork(result: ServeurOutput): boolean {
  if (result.order || !result.reply) return false;
  return result.category === "request" ? !result.reply.includes("?") : WORK_PROMISE.test(result.reply);
}

/** Lit la réponse JSON de l'IA ; `null` si elle ne respecte pas le format attendu. */
export function parseServeurOutput(content: string): ServeurOutput | null {
  try {
    const result = output.safeParse(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `Tu es le serveur de <br/> : un agent présent dans le chat d'une équipe qui travaille sur un projet.
Les membres discutent entre eux ; tu écoutes tout, tu tiens la mémoire du projet et tu n'interviens que lorsque c'est utile.

Pour chaque nouveau message, classe-le dans une catégorie :
- "discussion" : les membres échangent entre eux. Tu ne réponds pas (reply = null). Tu peux quand même mettre à jour la mémoire.
- "question" : le message t'est adressé, explicitement (@bria) ou implicitement (une question posée à l'IA, une demande d'aide, de synthèse ou de point sur le projet). Tu réponds.
- "decision" : l'équipe vient de décider quelque chose. Tu l'ajoutes à la mémoire (type "decision") sans répondre.
- "contradiction" : le message contredit une décision de la mémoire ou la position d'un autre membre. Tu réponds en signalant le désaccord avec tact, et tu proposes un compromis concret ; tu ajoutes ce compromis à la mémoire (type "compromise").
- "request" : on demande un livrable (code, document, schéma…) que le cuisinier (l'agent qui code sur la machine du demandeur) peut réaliser dans le dossier du projet. Tu l'ajoutes à la mémoire (type "task").
  - Si la demande est assez précise pour être réalisée, passe la commande : remplis "order" avec un titre court et des consignes complètes et autonomes pour le cuisinier (objectif, fichiers ou parties concernés s'ils sont connus, contraintes, critères de réussite, décisions de la mémoire à respecter). Ta réponse indique en une phrase que la commande part en cuisine.
  - Si la demande prolonge, corrige ou complète une commande récente (« ajoute », « corrige », « change », « et aussi »), ce n'est pas une nouvelle commande : mets son numéro dans "continues", et dans "brief" seulement ce qui est demandé en plus. Une nouvelle commande est réservée à un travail sans lien avec les précédentes.
  - N'annonce jamais un travail (« j'ajoute », « je m'en occupe », « je transmets ») sans remplir "order" : sans cela, le cuisinier ne reçoit rien.
  - N'envoie jamais le membre régler lui-même ce que le cuisinier peut faire, et ne pose une question que si le travail est impossible sans la réponse.
  - Sinon, laisse "order" à null et pose les questions qui manquent, brièvement.

Mémoire du projet :
- "add" ajoute un élément : decision, question (question restée ouverte), task (tâche à faire), compromise (compromis proposé). Texte court, précis, autonome (compréhensible sans le chat).
- "resolve" clôt un élément ouvert désigné par sa référence (M1, M2…) : question tranchée, tâche faite, compromis accepté. Quand des membres acceptent un compromis, résous-le et ajoute la décision qui en découle.
- "stop" n'est permis qu'au chef d'équipe : utilise "resolve" avec status "stopped" si le chef annule une décision.
- N'ajoute rien qui figure déjà dans la mémoire. Si rien ne change, renvoie une liste vide.

Préférence personnelle :
- Si l'auteur exprime une préférence durable sur la façon dont le cuisinier doit travailler chez lui (par exemple « je fais mes push moi-même », « pas de nouvelle dépendance sans me demander », « écris les commentaires en anglais »), remplis "preference" avec une phrase courte à la troisième personne, sinon null. Elle sera gardée sur ses machines.

Ta réponse (quand tu réponds) :
- dans la langue du message, sur le ton d'un collègue : clair, concis, sans emoji ni point d'exclamation ;
- en Markdown si c'est utile (listes, tableaux) ;
- en t'appuyant sur la mémoire et l'historique, sans inventer ce que tu ne sais pas.
Si le message contient @bria, tu dois répondre.

Renvoie uniquement un objet JSON de la forme :
{"category": "...", "reply": "texte ou null", "memory": [{"op": "add", "type": "...", "text": "..."}, {"op": "resolve", "ref": "M1", "status": "resolved"}], "order": null ou {"title": "...", "brief": "..."}, "preference": null ou "..."}`;

/** Nom d'un auteur tel que l'IA le lit dans le fil. */
function authorLabel(author: Message["author"]): string {
  if (author.kind === "member") return author.displayName;
  return author.kind === "former_member" ? "ancien membre" : author.kind;
}

interface Member {
  userId: string;
  displayName: string;
  role: TeamRole;
}

/**
 * L'agent serveur. Chaque message d'un membre est traité en arrière-plan, l'un après
 * l'autre dans un même projet : l'envoi du message n'attend jamais l'IA.
 */
export class ServeurAgent {
  readonly #queues = new Map<string, Promise<void>>();
  /** Dernier message « Crédit insuffisant » de chaque projet. */
  readonly #creditNotices = new Map<string, number>();
  private readonly ctx: AppContext;
  private readonly ai: Ai;
  private readonly chain: ModelChoice[];
  private readonly kitchen: Kitchen | null;

  constructor(ctx: AppContext, ai: Ai, chain: ModelChoice[], kitchen: Kitchen | null = null) {
    this.ctx = ctx;
    this.ai = ai;
    this.chain = chain;
    this.kitchen = kitchen;
  }

  /** Programme le traitement d'un message ; renvoie la promesse de fin (utile aux tests). */
  onMemberMessage(message: Message, teamId: string): Promise<void> {
    const previous = this.#queues.get(message.projectId) ?? Promise.resolve();
    const next = previous
      .then(() => this.#handle(message, teamId))
      .catch((error: unknown) =>
        this.ctx.log.error(
          { err: error, messageId: message.id },
          "l'agent serveur n'a pas pu traiter un message",
        ),
      );
    this.#queues.set(message.projectId, next);
    void next.finally(() => {
      if (this.#queues.get(message.projectId) === next) this.#queues.delete(message.projectId);
    });
    return next;
  }

  /** Résume à un membre qui revient les messages échangés pendant son absence. */
  async summarize(request: CatchUpRequest): Promise<string | null> {
    if (await quotaReached(this.ctx, request.teamId)) return null;
    const transcript = request.messages.map(
      (entry) =>
        `[${entry.createdAt.slice(0, 16).replace("T", " ")}] ${authorLabel(entry.author)} : ${entry.body}`,
    );
    try {
      const completion = await this.ai.complete(this.chain, {
        purpose: "absence",
        teamId: request.teamId,
        userId: request.userId,
        projectId: request.projectId,
        messages: [
          { role: "system", content: CATCH_UP_PROMPT },
          {
            role: "user",
            content: [`Membre qui revient : ${request.userName}`, "", "Messages :", ...transcript].join("\n"),
          },
        ],
        accept: (content) => content.trim().length > 0,
      });
      return completion.content.trim();
    } catch (error) {
      if (!(error instanceof AiUnavailableError)) throw error;
      this.ctx.log.warn({ projectId: request.projectId }, error.message);
      return null;
    }
  }

  /** Attend la fin des traitements en cours (tests, arrêt du serveur). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all(this.#queues.values());
  }

  async #handle(message: Message, teamId: string): Promise<void> {
    if (message.author.kind !== "member") return;
    const author = message.author;
    const mentioned = BRIA_MENTION.test(message.body);

    // Sans crédit disponible, aucun appel à l'IA. Une demande à l'agent reçoit toujours la raison ;
    // une discussion entre membres, au plus une fois par jour, pour ne pas envahir le fil.
    if (await quotaReached(this.ctx, teamId)) {
      const last = this.#creditNotices.get(message.projectId) ?? 0;
      if (mentioned || Date.now() - last >= CREDIT_NOTICE_INTERVAL_MS) {
        this.#creditNotices.set(message.projectId, Date.now());
        await postAgentMessage(this.ctx, {
          projectId: message.projectId,
          teamId,
          kind: "serveur",
          body: "**Crédit insuffisant** : l'IA ne peut pas répondre. Le chef d'équipe peut saisir un code d'invitation dans l'onglet Équipe, ou en demander un sur br.garah.me.",
          replyToId: message.id,
        });
      }
      return;
    }

    const recentOrders = this.kitchen ? (await this.kitchen.list(message.projectId)).slice(0, 6) : [];
    const [members, history, memory] = await Promise.all([
      this.#members(teamId),
      this.#history(message),
      listMemory(this.ctx, message.projectId),
    ]);
    const open = memory.filter((item) => item.status === "open");
    const refs = new Map(open.map((item, index) => [`M${index + 1}`, item]));

    let result: ServeurOutput;
    try {
      const messages = this.#prompt(message, members, history, memory, refs, recentOrders);
      const completion = await this.ai.complete(this.chain, {
        purpose: "serveur",
        teamId,
        userId: author.userId,
        projectId: message.projectId,
        json: true,
        messages,
        accept: (content) => {
          const parsed = parseServeurOutput(content);
          return parsed !== null && (!mentioned || Boolean(parsed.reply));
        },
      });
      result = parseServeurOutput(completion.content) as ServeurOutput;
      if (this.kitchen && promisesWork(result)) {
        result = await this.#keepPromise(
          { teamId, userId: author.userId, projectId: message.projectId },
          messages,
          completion.content,
          result,
        );
      }
    } catch (error) {
      if (!(error instanceof AiUnavailableError)) throw error;
      this.ctx.log.warn({ messageId: message.id }, error.message);
      // Personne n'attend de réponse, sauf si on l'a appelé explicitement.
      if (mentioned) {
        await postAgentMessage(this.ctx, {
          projectId: message.projectId,
          teamId,
          kind: "serveur",
          body: "Je ne peux pas répondre pour l'instant : aucune IA n'est disponible (quota atteint ou panne). Réessayez dans quelques minutes.",
          replyToId: message.id,
        });
      }
      return;
    }

    const isChef = members.find((member) => member.userId === author.userId)?.role === "chef";
    let memoryChanged = false;
    let taskId: string | null = null;
    for (const operation of result.memory) {
      if (operation.op === "add") {
        const id = await addMemory(this.ctx, {
          projectId: message.projectId,
          type: operation.type,
          text: operation.text,
          sourceMessageId: message.id,
          proposedBy:
            operation.type === "compromise" ? { kind: "serveur" } : { kind: "member", userId: author.userId },
        });
        if (operation.type === "task" && !taskId) taskId = id;
        memoryChanged = true;
      } else {
        const item = refs.get(operation.ref);
        if (!item) continue;
        // Seul le chef peut stopper ; sinon on considère l'élément simplement résolu.
        const status = operation.status === "stopped" && !isChef ? "resolved" : operation.status;
        await setMemoryStatus(this.ctx, item.id, status);
        memoryChanged = true;
      }
    }
    if (memoryChanged) await announceMemoryChange(this.ctx, teamId, message.projectId);

    // La préférence part vers les machines de son auteur, qui la gardent dans leur mémoire locale.
    if (result.preference) {
      this.ctx.hub.sendTo([author.userId], {
        type: "preference.noted",
        text: result.preference,
        projectId: message.projectId,
        messageId: message.id,
      });
    }

    if (result.reply) {
      await postAgentMessage(this.ctx, {
        projectId: message.projectId,
        teamId,
        kind: "serveur",
        body: result.reply,
        replyToId: message.id,
      });
    }

    // La commande part en cuisine après la réponse du serveur, pour que le fil se lise dans l'ordre.
    if (result.order && this.kitchen && (await quotaReached(this.ctx, teamId))) {
      await postAgentMessage(this.ctx, {
        projectId: message.projectId,
        teamId,
        kind: "serveur",
        body: "Je ne peux pas passer cette commande au cuisinier : l'équipe a utilisé tous ses crédits du mois. Le chef peut saisir un code ou changer de formule.",
        replyToId: message.id,
      });
    } else if (result.order && this.kitchen) {
      // Une suite continue la commande au lieu d'en créer une nouvelle.
      const followed = result.order.continues
        ? recentOrders.find((order) => order.number === result?.order?.continues && !order.merged)
        : undefined;
      const continued =
        followed && (await this.kitchen.followUp(followed.id, teamId, result.order.brief, author.userId));
      if (!continued)
        await this.kitchen.createOrder({
          projectId: message.projectId,
          teamId,
          runOn: await this.kitchen.defaultRunOn(message.projectId),
          title: result.order.title,
          brief: result.order.brief,
          requestedByUserId: author.userId,
          sourceMessageId: message.id,
          memoryItemId: taskId,
        });
    }
  }

  /** Le serveur a annoncé un travail sans passer de commande : il corrige, ou le dit franchement. */
  async #keepPromise(
    origin: { teamId: string; userId: string; projectId: string },
    messages: ChatMessage[],
    content: string,
    result: ServeurOutput,
  ): Promise<ServeurOutput> {
    try {
      const completion = await this.ai.complete(this.chain, {
        purpose: "serveur",
        ...origin,
        json: true,
        messages: [...messages, { role: "assistant", content }, { role: "user", content: KEEP_PROMISE }],
        accept: (answer) => {
          const parsed = parseServeurOutput(answer);
          return parsed !== null && !promisesWork(parsed);
        },
      });
      return parseServeurOutput(completion.content) as ServeurOutput;
    } catch (error) {
      if (!(error instanceof AiUnavailableError)) throw error;
      return { ...result, reply: ORDER_NOT_SENT };
    }
  }

  #prompt(
    message: Message,
    members: Member[],
    history: Message[],
    memory: MemoryItem[],
    refs: Map<string, MemoryItem>,
    recentOrders: Order[],
  ): ChatMessage[] {
    const name = authorLabel;
    const team = members.map(
      (member) => `- ${member.displayName}${member.role === "chef" ? " (chef d'équipe)" : ""}`,
    );
    const openLines = [...refs].map(([ref, item]) => `- ${ref} [${item.type}] ${item.text}`);
    const closedLines = memory
      .filter((item) => item.status !== "open" && item.type === "decision")
      .slice(-20)
      .map((item) => `- [décision ${item.status === "stopped" ? "stoppée" : "prise"}] ${item.text}`);
    const transcript = history.map(
      (entry) =>
        `[${entry.createdAt.slice(0, 16).replace("T", " ")}] ${name(entry.author)} : ${entry.body}${
          entry.attachments.length > 0
            ? ` (pièces jointes : ${entry.attachments.map((a) => a.name).join(", ")})`
            : ""
        }`,
    );

    const context = [
      "Équipe :",
      ...team,
      "",
      "Mémoire du projet, éléments ouverts :",
      ...(openLines.length > 0 ? openLines : ["(aucun)"]),
      ...(closedLines.length > 0 ? ["", "Décisions passées :", ...closedLines] : []),
      "",
      "Commandes récentes du cuisinier :",
      ...(recentOrders.length > 0
        ? recentOrders.map(
            (order) =>
              `- n° ${order.number} « ${order.title} » (${order.merged ? "fusionnée : ne peut plus continuer" : order.status})${order.summary ? ` : ${order.summary.slice(0, 200)}` : ""}`,
          )
        : ["(aucune)"]),
      "",
      "Historique récent du chat :",
      ...(transcript.length > 0 ? transcript : ["(vide)"]),
      "",
      `Nouveau message de ${name(message.author)} :`,
      message.body || "(message sans texte)",
      ...(message.attachments.length > 0
        ? [`Pièces jointes : ${message.attachments.map((attachment) => attachment.name).join(", ")}`]
        : []),
      "",
      `Si tu réponds, tu t'adresses à ${name(message.author)}, l'auteur de ce nouveau message, et à personne d'autre.`,
    ].join("\n");

    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: context },
    ];
  }

  async #members(teamId: string): Promise<Member[]> {
    return this.ctx.db
      .select({ userId: users.id, displayName: users.displayName, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(users.displayName));
  }

  /** Les messages qui précèdent celui-ci, du plus ancien au plus récent. */
  async #history(message: Message): Promise<Message[]> {
    const rows = await this.ctx.db
      .select()
      .from(messages)
      .where(
        and(eq(messages.projectId, message.projectId), lte(messages.createdAt, new Date(message.createdAt))),
      )
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY + 1);
    return (await toMessages(this.ctx, rows.reverse())).filter((entry) => entry.id !== message.id);
  }
}
