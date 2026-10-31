import type { FastifyBaseLogger } from "fastify";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** En développement : les e-mails sont écrits dans le journal du serveur. */
export class LogMailer implements Mailer {
  readonly #log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.#log = log;
  }

  async send(mail: Mail): Promise<void> {
    this.#log.info({ to: mail.to, subject: mail.subject }, `E-mail (non envoyé) :\n${mail.text}`);
  }
}

/** Envoi réel par Resend (https://resend.com). */
export class ResendMailer implements Mailer {
  readonly #apiKey: string;
  readonly #from: string;

  constructor(apiKey: string, from: string) {
    this.#apiKey = apiKey;
    this.#from = from;
  }

  async send(mail: Mail): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.#from, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!response.ok) {
      throw new Error(`Resend a refusé l'e-mail (${response.status}) : ${await response.text()}`);
    }
  }
}
