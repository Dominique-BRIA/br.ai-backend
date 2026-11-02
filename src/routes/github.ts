import type { RepoAppStatus } from "@br-ia/protocol";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Kitchen } from "../agents/cuisinier.ts";
import type { AppContext } from "../context.ts";
import { orders, projects } from "../db/schema.ts";
import { notFound, parse } from "../http/errors.ts";
import { memberIds, requireChef, roleIn } from "../services/access.ts";
import type { GitHubApp } from "../services/githubApp.ts";
import { postAgentMessage } from "../services/messages.ts";
import { recordOrderPullRequest } from "./orders.ts";

const projectParams = z.object({ projectId: z.uuid() });
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
});

const webhook = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ full_name: z.string() }).optional(),
  repositories_removed: z.array(z.object({ full_name: z.string() })).optional(),
  pull_request: z
    .object({
      number: z.number(),
      merged: z.boolean().optional(),
      head: z.object({ ref: z.string() }),
      base: z.object({ ref: z.string() }),
    })
    .optional(),
});

/** Page affichée dans le navigateur au retour de GitHub : textes fixes, rien de reçu n'y est repris. */
function page(title: string, text: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>&lt;br/&gt;</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;background:#fafafa;color:#1c1c1c}@media(prefers-color-scheme:dark){body{background:#161616;color:#ececec}}h1{font-size:1.3rem}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
}

/** Ce que le chef consulte pour proposer ou connecter l'application (F-GIT-10). */
export function githubAppRoutes(app: FastifyInstance, ctx: AppContext, github: GitHubApp | null): void {
  app.get("/projects/:projectId/repo/app", async (request): Promise<RepoAppStatus> => {
    const { projectId } = parse(projectParams, request.params);
    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
    if (!project || project.archivedAt) throw notFound("Projet introuvable.");
    await requireChef(ctx, request.userId, project.teamId);
    return {
      available: github !== null,
      connected: project.repoInstallationId !== null,
      installUrl: github ? github.installUrl(github.signState(projectId, request.userId)) : null,
    };
  });
}

/** Les routes appelées par GitHub, sans session : leur authenticité vient de leur signature. */
export function githubPublicRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  github: GitHubApp,
  kitchen: Kitchen | null,
): void {
  // La signature porte sur les octets reçus : le corps reste brut jusqu'à sa vérification.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/github/callback", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    const failed = (text: string) => reply.code(400).send(page("Connexion impossible", text));
    const { code, state } = parse(callbackQuery, request.query);
    const claim = state ? github.readState(state) : null;
    if (!claim) return failed("Ce lien a expiré. Relancez le branchement du dépôt depuis VS Code.");
    if (!code) {
      return failed("GitHub n'a pas confirmé votre compte. Relancez le branchement du dépôt depuis VS Code.");
    }
    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, claim.projectId));
    if (!project?.repoFullName || (await roleIn(ctx, claim.userId, project.teamId)) !== "chef") {
      return failed("Ce projet n'attend plus cette connexion.");
    }
    if (!(await github.userCanPush(code, project.repoFullName))) {
      return failed("Votre compte GitHub ne peut pas écrire dans le dépôt de ce projet.");
    }
    const installation = await github.installationFor(project.repoFullName);
    if (installation === null) {
      return failed(
        "L'application n'est pas installée sur le dépôt de ce projet. Choisissez-le à l'installation.",
      );
    }
    await ctx.db
      .update(projects)
      .set({ repoInstallationId: installation })
      .where(eq(projects.id, project.id));
    ctx.hub.sendTo(await memberIds(ctx, project.teamId), { type: "workspace.changed" });
    await postAgentMessage(ctx, {
      projectId: project.id,
      teamId: project.teamId,
      kind: "serveur",
      body: `L'application GitHub de <br/> est connectée à **${project.repoFullName}** : les validations passent maintenant par le serveur, et les fusions faites sur GitHub sont annoncées ici.`,
    });
    return reply.send(page("C'est fait", "L'application est connectée. Vous pouvez retourner dans VS Code."));
  });

  app.post("/github/webhook", async (request, reply) => {
    const raw = request.body as Buffer;
    const signature = request.headers["x-hub-signature-256"];
    if (
      !Buffer.isBuffer(raw) ||
      !github.verifyWebhook(raw, typeof signature === "string" ? signature : undefined)
    ) {
      return reply.code(401).send({ error: "signature" });
    }
    const parsed = webhook.safeParse(JSON.parse(raw.toString("utf8")));
    const event = request.headers["x-github-event"];
    if (parsed.success) await handleEvent(ctx, kitchen, String(event), parsed.data);
    return reply.code(204).send();
  });
}

async function handleEvent(
  ctx: AppContext,
  kitchen: Kitchen | null,
  event: string,
  payload: z.infer<typeof webhook>,
): Promise<void> {
  const installation = payload.installation?.id;
  if (installation === undefined) return;

  // L'application retirée : le projet repasse par les connexions des membres.
  if (event === "installation" && (payload.action === "deleted" || payload.action === "suspend")) {
    await ctx.db
      .update(projects)
      .set({ repoInstallationId: null })
      .where(eq(projects.repoInstallationId, installation));
    return;
  }
  if (event === "installation_repositories") {
    for (const { full_name: fullName } of payload.repositories_removed ?? []) {
      await ctx.db
        .update(projects)
        .set({ repoInstallationId: null })
        .where(and(eq(projects.repoInstallationId, installation), eq(projects.repoFullName, fullName)));
    }
    return;
  }

  const pull = payload.pull_request;
  const fullName = payload.repository?.full_name;
  if (event !== "pull_request" || payload.action !== "closed" || !pull?.merged || !fullName) return;
  // Seuls les projets connectés à cette installation sont prévenus : brancher le nom d'un dépôt ne suffit pas.
  const linked = await ctx.db
    .select()
    .from(projects)
    .where(and(eq(projects.repoFullName, fullName), eq(projects.repoInstallationId, installation)));
  for (const project of linked) {
    const [order] = kitchen
      ? await ctx.db
          .select()
          .from(orders)
          .where(and(eq(orders.projectId, project.id), eq(orders.branch, pull.head.ref)))
      : [];
    if (order && kitchen) {
      await recordOrderPullRequest(ctx, kitchen, {
        order,
        teamId: project.teamId,
        repoFullName: fullName,
        repoDefaultBranch: project.repoDefaultBranch,
        number: pull.number,
        merged: true,
      });
    } else if (pull.base.ref === project.repoDefaultBranch) {
      // Le titre de la pull request est écrit par n'importe qui : il n'entre pas dans le chat.
      await postAgentMessage(ctx, {
        projectId: project.id,
        teamId: project.teamId,
        kind: "serveur",
        body: `La [pull request n° ${pull.number}](https://github.com/${fullName}/pull/${pull.number}) est fusionnée dans \`${pull.base.ref}\` sur GitHub. Une nouvelle version est disponible.`,
        mentions: await memberIds(ctx, project.teamId),
      });
    }
  }
}
