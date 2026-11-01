import {
  createSecretBody,
  type ProjectSecret,
  type SecretLogResponse,
  type SecretsResponse,
  type SecretValuesResponse,
  updateSecretBody,
} from "@br-ia/protocol";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { projectSecrets, secretAccess, secretLog, users } from "../db/schema.ts";
import { forbidden, HttpError, notFound, parse } from "../http/errors.ts";
import { requireProject } from "../services/access.ts";
import { logSecret, requireVault, secretValuesFor, teamMembersAmong } from "../services/secrets.ts";

const projectParams = z.object({ projectId: z.uuid() });
const secretParams = z.object({ secretId: z.uuid() });

/**
 * Le coffre de secrets d'un projet. Le chef dépose les secrets et choisit qui y a accès ;
 * les valeurs ne sortent qu'à la demande d'un membre autorisé, pour écrire son `.env`,
 * et chaque sortie est notée dans le journal.
 */
export function secretRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Le secret et le projet, avec le rôle du membre dans l'équipe. */
  const loadSecret = async (userId: string, secretId: string) => {
    const [secret] = await ctx.db.select().from(projectSecrets).where(eq(projectSecrets.id, secretId));
    if (!secret) throw notFound("Secret introuvable.");
    const { project, role } = await requireProject(ctx, userId, secret.projectId);
    if (role !== "chef") throw forbidden("Seul le chef d'équipe gère le coffre.");
    return { secret, project };
  };

  const setAccess = async (secretId: string, userIds: string[]) => {
    await ctx.db.delete(secretAccess).where(eq(secretAccess.secretId, secretId));
    if (userIds.length > 0) {
      await ctx.db.insert(secretAccess).values(userIds.map((userId) => ({ secretId, userId })));
    }
  };

  app.get("/projects/:projectId/secrets", async (request): Promise<SecretsResponse> => {
    const { projectId } = parse(projectParams, request.params);
    const { role } = await requireProject(ctx, request.userId, projectId);
    const rows = await ctx.db
      .select()
      .from(projectSecrets)
      .where(eq(projectSecrets.projectId, projectId))
      .orderBy(asc(projectSecrets.name));
    const access =
      rows.length === 0
        ? []
        : await ctx.db
            .select()
            .from(secretAccess)
            .where(
              inArray(
                secretAccess.secretId,
                rows.map((row) => row.id),
              ),
            );
    const secrets: ProjectSecret[] = rows
      .filter(
        (row) =>
          role === "chef" ||
          access.some((entry) => entry.secretId === row.id && entry.userId === request.userId),
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        // Seul le chef voit qui a accès à quoi.
        access:
          role === "chef"
            ? access.filter((entry) => entry.secretId === row.id).map((entry) => entry.userId)
            : [],
        updatedAt: row.updatedAt.toISOString(),
      }));
    return { enabled: ctx.vault !== null, secrets };
  });

  app.post("/projects/:projectId/secrets", async (request): Promise<{ secret: ProjectSecret }> => {
    const { projectId } = parse(projectParams, request.params);
    const body = parse(createSecretBody, request.body);
    const { project, role } = await requireProject(ctx, request.userId, projectId);
    if (role !== "chef") throw forbidden("Seul le chef d'équipe gère le coffre.");
    const vault = requireVault(ctx);

    const [existing] = await ctx.db
      .select({ id: projectSecrets.id })
      .from(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, body.name)));
    if (existing) throw new HttpError(409, "secret_exists", `Le secret ${body.name} existe déjà.`);

    const [created] = await ctx.db
      .insert(projectSecrets)
      .values({ projectId, name: body.name, createdBy: request.userId, ...vault.seal(body.value) })
      .returning();
    if (!created) throw new Error("Secret non enregistré.");
    const access = await teamMembersAmong(ctx, project.teamId, body.access);
    await setAccess(created.id, access);
    await logSecret(ctx, { projectId, secretName: body.name, action: "created", userId: request.userId });
    return {
      secret: { id: created.id, name: created.name, access, updatedAt: created.updatedAt.toISOString() },
    };
  });

  app.patch("/secrets/:secretId", async (request): Promise<{ secret: ProjectSecret }> => {
    const { secretId } = parse(secretParams, request.params);
    const body = parse(updateSecretBody, request.body);
    const { secret, project } = await loadSecret(request.userId, secretId);

    const updatedAt = new Date();
    if (body.value !== undefined) {
      const sealed = requireVault(ctx).seal(body.value);
      await ctx.db
        .update(projectSecrets)
        .set({ ...sealed, updatedAt })
        .where(eq(projectSecrets.id, secretId));
      await logSecret(ctx, {
        projectId: secret.projectId,
        secretName: secret.name,
        action: "updated",
        userId: request.userId,
      });
    }
    if (body.access !== undefined) {
      await setAccess(secretId, await teamMembersAmong(ctx, project.teamId, body.access));
    }
    const access = await ctx.db
      .select({ userId: secretAccess.userId })
      .from(secretAccess)
      .where(eq(secretAccess.secretId, secretId));
    return {
      secret: {
        id: secretId,
        name: secret.name,
        access: access.map((entry) => entry.userId),
        updatedAt: (body.value !== undefined ? updatedAt : secret.updatedAt).toISOString(),
      },
    };
  });

  app.delete("/secrets/:secretId", async (request, reply) => {
    const { secretId } = parse(secretParams, request.params);
    const { secret } = await loadSecret(request.userId, secretId);
    await ctx.db.delete(projectSecrets).where(eq(projectSecrets.id, secretId));
    await logSecret(ctx, {
      projectId: secret.projectId,
      secretName: secret.name,
      action: "deleted",
      userId: request.userId,
    });
    return reply.code(204).send();
  });

  /** Les valeurs ouvertes au membre, pour écrire le `.env` de sa machine. */
  app.post("/projects/:projectId/secrets/values", async (request): Promise<SecretValuesResponse> => {
    const { projectId } = parse(projectParams, request.params);
    const { role } = await requireProject(ctx, request.userId, projectId);
    return { values: await secretValuesFor(ctx, projectId, request.userId, role) };
  });

  app.get("/projects/:projectId/secrets/log", async (request): Promise<SecretLogResponse> => {
    const { projectId } = parse(projectParams, request.params);
    const { role } = await requireProject(ctx, request.userId, projectId);
    if (role !== "chef") throw forbidden("Seul le chef d'équipe consulte le journal du coffre.");
    const rows = await ctx.db
      .select({
        id: secretLog.id,
        secretName: secretLog.secretName,
        action: secretLog.action,
        userName: users.displayName,
        createdAt: secretLog.createdAt,
      })
      .from(secretLog)
      .leftJoin(users, eq(users.id, secretLog.userId))
      .where(eq(secretLog.projectId, projectId))
      .orderBy(desc(secretLog.createdAt))
      .limit(100);
    return {
      entries: rows.map((row) => ({
        ...row,
        userName: row.userName ?? "",
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });
}
