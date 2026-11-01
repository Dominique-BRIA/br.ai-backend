import { scheduleMaintenanceBody } from "@br-ia/protocol";
import { and, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelChoice } from "../ai/client.ts";
import type { AppContext } from "../context.ts";
import {
  aiCalls,
  creditGrants,
  feedback,
  orders,
  plans,
  projects,
  sessions,
  teamMembers,
  teams,
  users,
} from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";
import { creditRates, currentMonth, saveCreditRates, teamUsage } from "../services/credits.ts";
import {
  getMaintenance,
  maintenanceStatus,
  reopenPlatform,
  scheduleMaintenance,
} from "../services/maintenance.ts";

const idParams = z.object({ id: z.uuid() });
const rate = z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000) });

/**
 * Les données du tableau de bord d'administration : vue d'ensemble, utilisateurs, équipes,
 * coûts d'IA, réglages (barème, formules), retours des testeurs. Protégées, comme toutes les
 * routes /admin, par le jeton d'administration. La valeur des secrets n'y apparaît jamais.
 */
export function dashboardRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  chains: { serveur: ModelChoice[]; cuisinier: ModelChoice[] },
): void {
  const since = (days: number) => new Date(Date.now() - days * 86_400_000);

  app.get("/admin/overview", async () => {
    const total = async (table: typeof users | typeof teams | typeof projects) =>
      (await ctx.db.select({ total: count() }).from(table))[0]?.total ?? 0;
    const orderCounts = await ctx.db
      .select({ status: orders.status, total: count() })
      .from(orders)
      .where(inArray(orders.status, ["pending", "running"]))
      .groupBy(orders.status);
    const [day] = await ctx.db
      .select({
        calls: count(),
        errors: sql<number>`count(*) filter (where not ${aiCalls.ok})`,
      })
      .from(aiCalls)
      .where(gte(aiCalls.createdAt, since(1)));
    // Refus des fournisseurs gratuits (limites de débit, quotas épuisés) sur 24 heures.
    const providerErrors = await ctx.db
      .select({ provider: aiCalls.provider, errors: count() })
      .from(aiCalls)
      .where(and(gte(aiCalls.createdAt, since(1)), eq(aiCalls.ok, false)))
      .groupBy(aiCalls.provider);
    const [newFeedback] = await ctx.db
      .select({ total: count() })
      .from(feedback)
      .where(eq(feedback.status, "new"));
    return {
      users: await total(users),
      teams: await total(teams),
      projects: await total(projects),
      machinesOnline: ctx.hub.machineCount,
      ordersPending: orderCounts.find((row) => row.status === "pending")?.total ?? 0,
      ordersRunning: orderCounts.find((row) => row.status === "running")?.total ?? 0,
      aiCalls24h: day?.calls ?? 0,
      aiErrors24h: Number(day?.errors ?? 0),
      providerErrors24h: providerErrors,
      newFeedback: newFeedback?.total ?? 0,
      chains: {
        serveur: chains.serveur.map((choice) => `${choice.provider.name}:${choice.model}`),
        cuisinier: chains.cuisinier.map((choice) => `${choice.provider.name}:${choice.model}`),
      },
    };
  });

  /** Coûts d'IA sur 30 jours : par fournisseur et modèle, et les équipes qui consomment le plus. */
  app.get("/admin/costs", async () => {
    const byModel = await ctx.db
      .select({
        provider: aiCalls.provider,
        model: aiCalls.model,
        calls: count(),
        inputTokens: sql<number>`coalesce(sum(${aiCalls.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${aiCalls.outputTokens}), 0)`,
        credits: sql<number>`coalesce(sum(${aiCalls.credits}), 0)`,
      })
      .from(aiCalls)
      .where(gte(aiCalls.createdAt, since(30)))
      .groupBy(aiCalls.provider, aiCalls.model)
      .orderBy(desc(sql`coalesce(sum(${aiCalls.credits}), 0)`));
    const byTeam = await ctx.db
      .select({
        teamId: aiCalls.teamId,
        name: teams.name,
        calls: count(),
        credits: sql<number>`coalesce(sum(${aiCalls.credits}), 0)`,
      })
      .from(aiCalls)
      .innerJoin(teams, eq(teams.id, aiCalls.teamId))
      .where(gte(aiCalls.createdAt, since(30)))
      .groupBy(aiCalls.teamId, teams.name)
      .orderBy(desc(sql`coalesce(sum(${aiCalls.credits}), 0)`))
      .limit(10);
    const byPurpose = await ctx.db
      .select({
        purpose: aiCalls.purpose,
        calls: count(),
        credits: sql<number>`coalesce(sum(${aiCalls.credits}), 0)`,
      })
      .from(aiCalls)
      .where(gte(aiCalls.createdAt, since(30)))
      .groupBy(aiCalls.purpose);
    const numbers = <T extends Record<string, unknown>>(rows: T[]) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value,
          ]),
        ),
      );
    return { byModel: numbers(byModel), byTeam: numbers(byTeam), byPurpose: numbers(byPurpose) };
  });

  app.get("/admin/users", async (request) => {
    const { search } = parse(z.object({ search: z.string().trim().max(100).default("") }), request.query);
    const rows = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        createdAt: users.createdAt,
        suspendedAt: users.suspendedAt,
        teams: sql<number>`(select count(*) from ${teamMembers} where ${teamMembers.userId} = ${users.id})`,
        lastSeenAt: sql<Date | null>`(select max(${sessions.lastSeenAt}) from ${sessions} where ${sessions.userId} = ${users.id})`,
      })
      .from(users)
      .where(
        search ? or(ilike(users.email, `%${search}%`), ilike(users.displayName, `%${search}%`)) : undefined,
      )
      .orderBy(desc(users.createdAt))
      .limit(200);
    return {
      users: rows.map((row) => ({
        ...row,
        teams: Number(row.teams),
        createdAt: row.createdAt.toISOString(),
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
        online: ctx.hub.isOnline(row.id),
      })),
    };
  });

  /** Suspend un compte (ses machines sont déconnectées sur-le-champ) ou lève la suspension. */
  app.patch("/admin/users/:id", async (request) => {
    const { id } = parse(idParams, request.params);
    const { suspended } = parse(z.object({ suspended: z.boolean() }), request.body);
    const [user] = await ctx.db
      .update(users)
      .set({ suspendedAt: suspended ? new Date() : null })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!user) throw new HttpError(404, "not_found", "Compte introuvable.");
    if (suspended) for (const sessionId of ctx.hub.onlineSessions(id)) ctx.hub.closeSession(id, sessionId);
    return { ok: true };
  });

  app.get("/admin/teams", async () => {
    const rows = await ctx.db
      .select({
        id: teams.id,
        name: teams.name,
        planId: teams.planId,
        planEndsAt: teams.planEndsAt,
        createdAt: teams.createdAt,
        members: sql<number>`(select count(*) from ${teamMembers} where ${teamMembers.teamId} = ${teams.id})`,
        projects: sql<number>`(select count(*) from ${projects} where ${projects.teamId} = ${teams.id} and ${projects.archivedAt} is null)`,
      })
      .from(teams)
      .orderBy(desc(teams.createdAt))
      .limit(200);
    const result = [];
    for (const row of rows) {
      const usage = await teamUsage(ctx, row.id);
      result.push({
        ...row,
        members: Number(row.members),
        projects: Number(row.projects),
        planEndsAt: row.planEndsAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        effectivePlan: usage.plan.name,
        used: usage.used,
        quota: usage.quota,
      });
    }
    return { teams: result };
  });

  /** Change la formule d'une équipe, ou lui accorde des crédits pour le mois. */
  app.patch("/admin/teams/:id", async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.object({
        planId: z.string().optional(),
        planEndsAt: z.iso.datetime().nullable().optional(),
        grantCredits: z.number().int().min(1).max(10_000_000).optional(),
      }),
      request.body,
    );
    if (body.planId) {
      const [plan] = await ctx.db.select({ id: plans.id }).from(plans).where(eq(plans.id, body.planId));
      if (!plan) throw new HttpError(400, "invalid_request", "Formule inconnue.");
    }
    if (body.planId !== undefined || body.planEndsAt !== undefined) {
      await ctx.db
        .update(teams)
        .set({
          ...(body.planId !== undefined && { planId: body.planId }),
          ...(body.planEndsAt !== undefined && {
            planEndsAt: body.planEndsAt ? new Date(body.planEndsAt) : null,
          }),
        })
        .where(eq(teams.id, id));
    }
    if (body.grantCredits) {
      await ctx.db
        .insert(creditGrants)
        .values({ teamId: id, credits: body.grantCredits, month: currentMonth(), source: "administrateur" });
    }
    return { ok: true };
  });

  app.get("/admin/plans", async () => ({
    plans: await ctx.db.select().from(plans).orderBy(plans.sortOrder),
  }));

  app.patch("/admin/plans/:id", async (request) => {
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(40).optional(),
        maxMembers: z.number().int().min(1).max(10_000).optional(),
        maxProjects: z.number().int().min(1).max(10_000).optional(),
        monthlyCredits: z.number().int().min(0).max(100_000_000).optional(),
      }),
      request.body,
    );
    const [plan] = await ctx.db.update(plans).set(body).where(eq(plans.id, id)).returning();
    if (!plan) throw new HttpError(404, "not_found", "Formule introuvable.");
    return { plan };
  });

  app.get("/admin/credit-rates", async () => ({ rates: await creditRates(ctx) }));

  app.put("/admin/credit-rates", async (request) => {
    const rates = parse(z.object({ default: rate, models: z.record(z.string(), rate) }), request.body);
    await saveCreditRates(ctx, rates);
    return { rates };
  });

  app.get("/admin/feedback", async () => {
    const rows = await ctx.db
      .select({
        id: feedback.id,
        text: feedback.text,
        status: feedback.status,
        extensionVersion: feedback.extensionVersion,
        createdAt: feedback.createdAt,
        userName: users.displayName,
        userEmail: users.email,
      })
      .from(feedback)
      .leftJoin(users, eq(users.id, feedback.userId))
      .orderBy(desc(feedback.createdAt))
      .limit(300);
    return { feedback: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  });

  app.patch("/admin/feedback/:id", async (request) => {
    const { id } = parse(idParams, request.params);
    const { status } = parse(z.object({ status: z.enum(["new", "in_progress", "done"]) }), request.body);
    const [row] = await ctx.db.update(feedback).set({ status }).where(eq(feedback.id, id)).returning();
    if (!row) throw new HttpError(404, "not_found", "Retour introuvable.");
    return { ok: true };
  });

  app.get("/admin/maintenance", async () => {
    const maintenance = await getMaintenance(ctx);
    return { maintenance, status: maintenanceStatus(maintenance) };
  });

  /** Programme une maintenance ; les machines connectées sont prévenues tout de suite. */
  app.put("/admin/maintenance", async (request) => {
    const body = parse(scheduleMaintenanceBody, request.body);
    await scheduleMaintenance(ctx, body);
    return { status: maintenanceStatus(body) };
  });

  /** Rouvre la plateforme d'un clic, avec une notification aux membres. */
  app.delete("/admin/maintenance", async () => {
    await reopenPlatform(ctx);
    return { ok: true };
  });

  /** Commandes en attente faute de machine, pour la santé de la plateforme. */
  app.get("/admin/pending-orders", async () => {
    const rows = await ctx.db
      .select({
        id: orders.id,
        number: orders.number,
        title: orders.title,
        createdAt: orders.createdAt,
        project: projects.name,
        team: teams.name,
      })
      .from(orders)
      .innerJoin(projects, eq(projects.id, orders.projectId))
      .innerJoin(teams, eq(teams.id, projects.teamId))
      .where(and(eq(orders.status, "pending"), isNull(projects.archivedAt)))
      .orderBy(orders.createdAt)
      .limit(100);
    return { orders: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  });
}
