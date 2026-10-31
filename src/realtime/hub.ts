import type { MachineInfo, ServerEvent } from "@br-ia/protocol";

export interface LiveConnection {
  connectionId: string;
  userId: string;
  machine: MachineInfo;
  send(event: ServerEvent): void;
}

/**
 * Les machines connectées, regroupées par membre.
 * Sert à savoir qui est en ligne et à pousser les événements en temps réel.
 */
export class RealtimeHub {
  readonly #byUser = new Map<string, Map<string, LiveConnection>>();

  /** Renvoie vrai si c'est la première machine connectée de ce membre. */
  add(connection: LiveConnection): boolean {
    let connections = this.#byUser.get(connection.userId);
    const first = !connections;
    if (!connections) {
      connections = new Map();
      this.#byUser.set(connection.userId, connections);
    }
    connections.set(connection.connectionId, connection);
    return first;
  }

  /** Renvoie vrai si c'était la dernière machine connectée de ce membre. */
  remove(connection: LiveConnection): boolean {
    const connections = this.#byUser.get(connection.userId);
    if (!connections) return false;
    connections.delete(connection.connectionId);
    if (connections.size > 0) return false;
    this.#byUser.delete(connection.userId);
    return true;
  }

  isOnline(userId: string): boolean {
    return this.#byUser.has(userId);
  }

  get machineCount(): number {
    let count = 0;
    for (const connections of this.#byUser.values()) count += connections.size;
    return count;
  }

  sendTo(userIds: Iterable<string>, event: ServerEvent): void {
    for (const userId of new Set(userIds)) {
      for (const connection of this.#byUser.get(userId)?.values() ?? []) {
        connection.send(event);
      }
    }
  }
}
