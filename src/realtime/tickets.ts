import { randomBytes } from "node:crypto";

/** Un ticket ne sert qu'une fois, et seulement dans la minute. */
const TICKET_TTL_MS = 60_000;

interface Ticket {
  sessionId: string;
  expiresAt: number;
}

/**
 * Tickets de connexion temps réel pour la plateforme web. Le jeton de session y reste dans un
 * cookie que la page ne lit pas : le site demande un ticket à sa place, et le navigateur ouvre la
 * connexion avec ce ticket, utilisable une seule fois.
 */
export class RealtimeTickets {
  readonly #tickets = new Map<string, Ticket>();

  issue(sessionId: string, now = Date.now()): { ticket: string; expiresAt: string } {
    for (const [key, entry] of this.#tickets) if (entry.expiresAt <= now) this.#tickets.delete(key);
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = now + TICKET_TTL_MS;
    this.#tickets.set(ticket, { sessionId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** La session du ticket, s'il est encore valable ; il est consommé dans tous les cas. */
  take(ticket: string, now = Date.now()): string | null {
    const entry = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    return entry && entry.expiresAt > now ? entry.sessionId : null;
  }
}
