import type { TeamRole } from "@br-ia/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { projectSecrets, projects, secretAccess, secretLog, teamMembers, users } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import type { Vault } from "../secrets/vault.ts";
import { postAgentMessage } from "./messages.ts";

export function requireVault(ctx: AppContext): Vault {
  if (!ctx.vault) {
    throw new HttpError(503, "vault_disabled", "Le coffre de secrets n'est pas activé sur ce serveur.");
  }
  return ctx.vault;
}

export async function logSecret(
  ctx: AppContext,
  entry: {
    projectId: string;
    secretName: string;
    action: "created" | "updated" | "deleted" | "read";
    userId: string;
  },
): Promise<void> {
  await ctx.db.insert(secretLog).values(entry);
}

/** Ne garde, parmi les membres choisis, que ceux de l'équipe. */
export async function teamMembersAmong(
  ctx: AppContext,
  teamId: string,
  userIds: string[],
): Promise<string[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const rows = await ctx.db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.userId, unique)));
  return rows.map((row) => row.userId);
}

/**
 * Les valeurs des secrets d'un projet ouverts à un membre (tous pour le chef), déchiffrées.
 * Chaque récupération est notée dans le journal.
 */
export async function secretValuesFor(
  ctx: AppContext,
  projectId: string,
  userId: string,
  role: TeamRole,
): Promise<{ name: string; value: string }[]> {
  const vault = requireVault(ctx);
  const rows =
    role === "chef"
      ? await ctx.db
          .select()
          .from(projectSecrets)
          .where(eq(projectSecrets.projectId, projectId))
          .orderBy(asc(projectSecrets.name))
      : (
          await ctx.db
            .select({ secret: projectSecrets })
            .from(projectSecrets)
            .innerJoin(
              secretAccess,
              and(eq(secretAccess.secretId, projectSecrets.id), eq(secretAccess.userId, userId)),
            )
            .where(eq(projectSecrets.projectId, projectId))
            .orderBy(asc(projectSecrets.name))
        ).map((row) => row.secret);
  const values = rows.map((row) => ({ name: row.name, value: vault.open(row) }));
  for (const row of rows) await logSecret(ctx, { projectId, secretName: row.name, action: "read", userId });
  return values;
}

/** Noms des secrets d'un projet, pour le cuisinier : il ne voit jamais les valeurs. */
export async function secretNames(ctx: AppContext, projectId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(eq(projectSecrets.projectId, projectId))
    .orderBy(asc(projectSecrets.name));
  return rows.map((row) => row.name);
}

/**
 * Un membre quitte l'équipe : il perd ses accès au coffre, et le serveur rappelle au chef,
 * dans chaque projet concerné, de changer les secrets qu'il pouvait récupérer.
 */
export async function revokeSecretsOnDeparture(
  ctx: AppContext,
  teamId: string,
  userId: string,
): Promise<void> {
  const rows = await ctx.db
    .select({ secretId: projectSecrets.id, name: projectSecrets.name, projectId: projectSecrets.projectId })
    .from(secretAccess)
    .innerJoin(projectSecrets, eq(projectSecrets.id, secretAccess.secretId))
    .innerJoin(projects, eq(projects.id, projectSecrets.projectId))
    .where(and(eq(secretAccess.userId, userId), eq(projects.teamId, teamId)));
  if (rows.length === 0) return;

  await ctx.db.delete(secretAccess).where(
    and(
      eq(secretAccess.userId, userId),
      inArray(
        secretAccess.secretId,
        rows.map((row) => row.secretId),
      ),
    ),
  );

  const [member] = await ctx.db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  const chefs = await ctx.db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "chef")));
  const byProject = new Map<string, typeof rows>();
  for (const row of rows) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row]);
  for (const [projectId, secrets] of byProject) {
    const names = secrets.map((secret) => `\`${secret.name}\``).join(", ");
    await postAgentMessage(ctx, {
      projectId,
      teamId,
      kind: "serveur",
      body: `${member?.displayName ?? "Un membre"} a quitté l'équipe. Il pouvait récupérer ces secrets du coffre : ${names}. Par précaution, pensez à les changer.`,
      mentions: chefs.map((chef) => chef.userId),
    });
  }
}
