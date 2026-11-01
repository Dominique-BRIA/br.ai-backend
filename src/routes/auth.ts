import {
  type RequestCodeResponse,
  requestCodeBody,
  type VerifyCodeResponse,
  verifyCodeBody,
} from "@br-ia/protocol";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loginCodeHash, newLoginCode, normalizeInvitationCode } from "../auth/secrets.ts";
import { bearerToken, openSession, revokeSession } from "../auth/sessions.ts";
import type { AppContext } from "../context.ts";
import { betaInvites, loginCodes, teamInvitations, teamMembers, users } from "../db/schema.ts";
import { HttpError, parse } from "../http/errors.ts";
import { loginCodeMail } from "../mail/templates.ts";
import { memberIds } from "../services/access.ts";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const RESEND_DELAY_MS = 60_000;

type Invitation = { kind: "beta" | "team"; id: string; teamId?: string };

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/auth/code", async (request): Promise<RequestCodeResponse> => {
    const { email, invitationCode } = parse(requestCodeBody, request.body);
    const [existing] = await ctx.db
      .select({ id: users.id, locale: users.locale })
      .from(users)
      .where(eq(users.email, email));

    let invitation: Invitation | null = null;
    if (!existing) {
      if (!invitationCode) {
        throw new HttpError(
          403,
          "invitation_required",
          "Un code d'invitation est nécessaire pour créer un compte.",
        );
      }
      invitation = await findInvitation(ctx, invitationCode);
      if (!invitation)
        throw new HttpError(403, "invitation_invalid", "Ce code d'invitation n'est pas valable.");
    }

    const [recent] = await ctx.db
      .select({ createdAt: loginCodes.createdAt })
      .from(loginCodes)
      .where(eq(loginCodes.email, email))
      .orderBy(desc(loginCodes.createdAt))
      .limit(1);
    if (recent && Date.now() - recent.createdAt.getTime() < RESEND_DELAY_MS) {
      throw new HttpError(
        429,
        "too_many_requests",
        "Un code vient d'être envoyé. Réessayez dans une minute.",
      );
    }

    const code = newLoginCode();
    const [stored] = await ctx.db
      .insert(loginCodes)
      .values({
        email,
        codeHash: loginCodeHash(email, code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        invitationKind: invitation?.kind,
        invitationId: invitation?.id,
      })
      .returning({ id: loginCodes.id });
    try {
      await ctx.mailer.send(loginCodeMail(email, code, existing?.locale ?? "fr"));
    } catch (error) {
      // Code jamais reçu : on l'oublie, pour qu'un nouvel essai ne soit pas bloqué une minute.
      if (stored) await ctx.db.delete(loginCodes).where(eq(loginCodes.id, stored.id));
      throw error;
    }
    return { newAccount: !existing };
  });

  app.post("/auth/verify", async (request): Promise<VerifyCodeResponse> => {
    const { email, code, machineId, displayName } = parse(verifyCodeBody, request.body);

    const [pending] = await ctx.db
      .select()
      .from(loginCodes)
      .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt)))
      .orderBy(desc(loginCodes.createdAt))
      .limit(1);
    if (!pending) throw new HttpError(401, "code_invalid", "Code incorrect.");
    if (pending.expiresAt.getTime() < Date.now()) {
      throw new HttpError(401, "code_expired", "Ce code a expiré. Demandez-en un nouveau.");
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      throw new HttpError(429, "too_many_attempts", "Trop d'essais. Demandez un nouveau code.");
    }
    if (pending.codeHash !== loginCodeHash(email, code)) {
      await ctx.db
        .update(loginCodes)
        .set({ attempts: sql`${loginCodes.attempts} + 1` })
        .where(eq(loginCodes.id, pending.id));
      throw new HttpError(401, "code_invalid", "Code incorrect.");
    }

    let [user] = await ctx.db.select().from(users).where(eq(users.email, email));
    if (!user && !displayName) {
      throw new HttpError(400, "display_name_required", "Indiquez le nom à afficher pour votre compte.");
    }

    await ctx.db.update(loginCodes).set({ consumedAt: new Date() }).where(eq(loginCodes.id, pending.id));

    if (!user && displayName) {
      const invitation =
        pending.invitationKind && pending.invitationId
          ? await invitationById(ctx, pending.invitationKind, pending.invitationId)
          : null;
      if (!invitation)
        throw new HttpError(403, "invitation_invalid", "Ce code d'invitation n'est plus valable.");
      [user] = await ctx.db.insert(users).values({ email, displayName }).returning();
      if (!user) throw new Error("Création du compte impossible.");
      await consumeInvitation(ctx, invitation, user.id);
    }
    if (!user) throw new HttpError(401, "code_invalid", "Code incorrect.");

    const token = await openSession(ctx, user.id, machineId);
    return {
      token,
      user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale },
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = bearerToken(request);
    if (token) await revokeSession(ctx, token);
    return reply.code(204).send();
  });
}

/** Cherche une invitation valable : d'abord à la bêta, puis à une équipe. */
async function findInvitation(ctx: AppContext, rawCode: string): Promise<Invitation | null> {
  const code = normalizeInvitationCode(rawCode);
  const now = new Date();
  const [beta] = await ctx.db
    .select({
      id: betaInvites.id,
      uses: betaInvites.uses,
      maxUses: betaInvites.maxUses,
      expiresAt: betaInvites.expiresAt,
    })
    .from(betaInvites)
    .where(eq(betaInvites.code, code));
  if (beta && beta.uses < beta.maxUses && (!beta.expiresAt || beta.expiresAt > now)) {
    return { kind: "beta", id: beta.id };
  }
  const [team] = await ctx.db
    .select({ id: teamInvitations.id, teamId: teamInvitations.teamId })
    .from(teamInvitations)
    .where(
      and(
        eq(teamInvitations.code, code),
        isNull(teamInvitations.revokedAt),
        gt(teamInvitations.expiresAt, now),
      ),
    );
  return team ? { kind: "team", id: team.id, teamId: team.teamId } : null;
}

async function invitationById(
  ctx: AppContext,
  kind: "beta" | "team",
  id: string,
): Promise<Invitation | null> {
  if (kind === "beta") {
    const [beta] = await ctx.db.select().from(betaInvites).where(eq(betaInvites.id, id));
    return beta && beta.uses < beta.maxUses && (!beta.expiresAt || beta.expiresAt > new Date())
      ? { kind, id }
      : null;
  }
  const [team] = await ctx.db
    .select()
    .from(teamInvitations)
    .where(
      and(
        eq(teamInvitations.id, id),
        isNull(teamInvitations.revokedAt),
        gt(teamInvitations.expiresAt, new Date()),
      ),
    );
  return team ? { kind, id, teamId: team.teamId } : null;
}

/** Une invitation à la bêta est décomptée ; une invitation d'équipe fait entrer le nouveau compte dans l'équipe. */
async function consumeInvitation(ctx: AppContext, invitation: Invitation, userId: string): Promise<void> {
  if (invitation.kind === "beta") {
    await ctx.db
      .update(betaInvites)
      .set({ uses: sql`${betaInvites.uses} + 1` })
      .where(eq(betaInvites.id, invitation.id));
    return;
  }
  if (!invitation.teamId) return;
  await ctx.db.insert(teamMembers).values({ teamId: invitation.teamId, userId, role: "membre" });
  ctx.hub.sendTo(await memberIds(ctx, invitation.teamId), { type: "workspace.changed" });
}
