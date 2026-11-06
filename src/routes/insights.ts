import { and, count, countDistinct, desc, eq, inArray, ne, type SQL, sql, sum } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { adminAudit, aiCalls, messages, orders, projects, teams, users } from "../db/schema.ts";
import { parse } from "../http/errors.ts";
import { CLOUD_USER_ID } from "../services/cloud.ts";

const statisticsQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
    .default(30),
  /** Fuseau du navigateur, pour que les jours et les heures soient ceux de l'équipe. */
  tz: z.string().max(64).default("UTC"),
});

const auditQuery = z.object({
  action: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/**
 * Regroupe par la n-ième colonne du select : le fuseau, passé en paramètre, rend chaque copie
 * de l'expression différente aux yeux de PostgreSQL.
 */
const byPosition = (position: number) => sql.raw(String(position));

/** Le fuseau demandé s'il existe, UTC sinon. */
function timeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Les jours de la période, du plus ancien au plus récent, au format AAAA-MM-JJ dans ce fuseau. */
function periodDays(days: number, tz: string): string[] {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Array.from({ length: days }, (_, index) =>
    format.format(new Date(Date.now() - (days - 1 - index) * 86_400_000)),
  );
}

/**
 * Statistiques et journal du tableau de bord. Les statistiques couvrent une période (7, 30 ou
 * 90 jours) et la comparent à la précédente ; le journal liste les actions de l'équipe interne.
 */
export function insightRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/admin/statistics", async (request) => {
    const query = parse(statisticsQuery, request.query);
    const tz = timeZone(query.tz);
    const days = periodDays(query.days, tz);
    const first = days[0] as string;
    const last = days.at(-1) as string;
    const previousFirst = periodDays(query.days * 2, tz)[0] as string;

    const day = (column: PgColumn) => sql<string>`to_char(${column} at time zone ${tz}, 'YYYY-MM-DD')`;
    const localDate = (column: PgColumn) => sql`(${column} at time zone ${tz})::date`;
    const inPeriod = (column: PgColumn): SQL =>
      sql`${localDate(column)} between ${first}::date and ${last}::date`;
    const inPrevious = (column: PgColumn): SQL =>
      sql`${localDate(column)} >= ${previousFirst}::date and ${localDate(column)} < ${first}::date`;

    // Les totaux de la période et de la précédente, pour les tendances.
    const totals = async (range: (column: PgColumn) => SQL) => {
      const [newUsers] = await ctx.db
        .select({ value: count() })
        .from(users)
        .where(and(range(users.createdAt), ne(users.id, CLOUD_USER_ID)));
      const [messageRow] = await ctx.db
        .select({
          value: count(),
          active: countDistinct(messages.authorUserId),
        })
        .from(messages)
        .where(range(messages.createdAt));
      const [orderRow] = await ctx.db.select({ value: count() }).from(orders).where(range(orders.createdAt));
      const [aiRow] = await ctx.db
        .select({ calls: count(), credits: sum(aiCalls.credits) })
        .from(aiCalls)
        .where(range(aiCalls.createdAt));
      return {
        newUsers: newUsers?.value ?? 0,
        messages: messageRow?.value ?? 0,
        activeMembers: messageRow?.active ?? 0,
        orders: orderRow?.value ?? 0,
        aiCalls: aiRow?.calls ?? 0,
        credits: Math.round(Number(aiRow?.credits ?? 0)),
      };
    };

    const messagesByDay = await ctx.db
      .select({ day: day(messages.createdAt), kind: messages.authorKind, value: count() })
      .from(messages)
      .where(inPeriod(messages.createdAt))
      .groupBy(byPosition(1), messages.authorKind);
    const usersByDay = await ctx.db
      .select({ day: day(users.createdAt), value: count() })
      .from(users)
      .where(and(inPeriod(users.createdAt), ne(users.id, CLOUD_USER_ID)))
      .groupBy(byPosition(1));
    const ordersByDay = await ctx.db
      .select({ day: day(orders.createdAt), value: count() })
      .from(orders)
      .where(inPeriod(orders.createdAt))
      .groupBy(byPosition(1));
    const aiByDay = await ctx.db
      .select({
        day: day(aiCalls.createdAt),
        ok: sql<number>`count(*) filter (where ${aiCalls.ok})`,
        failed: sql<number>`count(*) filter (where not ${aiCalls.ok})`,
        credits: sum(aiCalls.credits),
      })
      .from(aiCalls)
      .where(inPeriod(aiCalls.createdAt))
      .groupBy(byPosition(1));

    const timeline = days.map((date) => {
      const messageCount = (kind: "member" | "serveur" | "cuisinier") =>
        messagesByDay.find((row) => row.day === date && row.kind === kind)?.value ?? 0;
      const ai = aiByDay.find((row) => row.day === date);
      return {
        date,
        members: messageCount("member"),
        serveur: messageCount("serveur"),
        cuisinier: messageCount("cuisinier"),
        newUsers: usersByDay.find((row) => row.day === date)?.value ?? 0,
        orders: ordersByDay.find((row) => row.day === date)?.value ?? 0,
        aiOk: Number(ai?.ok ?? 0),
        aiFailed: Number(ai?.failed ?? 0),
        credits: Math.round(Number(ai?.credits ?? 0)),
      };
    });

    const orderStatuses = await ctx.db
      .select({ status: orders.status, value: count() })
      .from(orders)
      .where(inPeriod(orders.createdAt))
      .groupBy(orders.status);

    // Heures de pointe : messages des membres, par jour de la semaine (1 = lundi) et par heure.
    const heatmap = await ctx.db
      .select({
        weekday: sql<number>`extract(isodow from ${messages.createdAt} at time zone ${tz})::int`,
        hour: sql<number>`extract(hour from ${messages.createdAt} at time zone ${tz})::int`,
        value: count(),
      })
      .from(messages)
      .where(and(inPeriod(messages.createdAt), eq(messages.authorKind, "member")))
      .groupBy(byPosition(1), byPosition(2));

    const providers = await ctx.db
      .select({
        provider: aiCalls.provider,
        ok: sql<number>`count(*) filter (where ${aiCalls.ok})`,
        failed: sql<number>`count(*) filter (where not ${aiCalls.ok})`,
      })
      .from(aiCalls)
      .where(inPeriod(aiCalls.createdAt))
      .groupBy(aiCalls.provider);

    // Les équipes les plus actives : messages et commandes de leurs projets, crédits consommés.
    const teamMessages = await ctx.db
      .select({ teamId: projects.teamId, value: count() })
      .from(messages)
      .innerJoin(projects, eq(projects.id, messages.projectId))
      .where(inPeriod(messages.createdAt))
      .groupBy(projects.teamId);
    const teamOrders = await ctx.db
      .select({ teamId: projects.teamId, value: count() })
      .from(orders)
      .innerJoin(projects, eq(projects.id, orders.projectId))
      .where(inPeriod(orders.createdAt))
      .groupBy(projects.teamId);
    const teamCredits = await ctx.db
      .select({ teamId: aiCalls.teamId, value: sum(aiCalls.credits) })
      .from(aiCalls)
      .where(inPeriod(aiCalls.createdAt))
      .groupBy(aiCalls.teamId);
    const teamIds = [...new Set(teamMessages.map((row) => row.teamId))];
    const names = teamIds.length
      ? await ctx.db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds))
      : [];
    const topTeams = teamIds
      .map((teamId) => ({
        id: teamId,
        name: names.find((team) => team.id === teamId)?.name ?? "Équipe supprimée",
        messages: teamMessages.find((row) => row.teamId === teamId)?.value ?? 0,
        orders: teamOrders.find((row) => row.teamId === teamId)?.value ?? 0,
        credits: Math.round(Number(teamCredits.find((row) => row.teamId === teamId)?.value ?? 0)),
      }))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 8);

    return {
      days: query.days,
      timeZone: tz,
      current: await totals(inPeriod),
      previous: await totals(inPrevious),
      timeline,
      orderStatuses: orderStatuses.map((row) => ({ status: row.status, value: row.value })),
      heatmap: heatmap.map((row) => ({
        weekday: Number(row.weekday),
        hour: Number(row.hour),
        value: row.value,
      })),
      providers: providers.map((row) => ({
        provider: row.provider,
        ok: Number(row.ok),
        failed: Number(row.failed),
      })),
      topTeams,
    };
  });

  app.get("/admin/audit", async (request) => {
    const { action, limit } = parse(auditQuery, request.query);
    const rows = await ctx.db
      .select()
      .from(adminAudit)
      .where(action ? eq(adminAudit.action, action) : undefined)
      .orderBy(desc(adminAudit.createdAt))
      .limit(limit);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        method: row.method,
        route: row.route,
        targetId: row.targetId,
        detail: row.detail,
        statusCode: row.statusCode,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  /** Les actions présentes dans le journal, avec leur nombre, pour le filtre. */
  app.get("/admin/audit/actions", async () => {
    const rows = await ctx.db
      .select({ action: adminAudit.action, value: count() })
      .from(adminAudit)
      .groupBy(adminAudit.action)
      .orderBy(desc(count()));
    return { actions: rows };
  });
}
