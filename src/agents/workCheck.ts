/** Fichiers qu'il faut exécuter pour les vérifier ; relire les autres suffit (document, page, données). */
const CODE_FILE =
  /\.(js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|sh|bash|swift|dart|vue|svelte|lua|pl)$/i;
/** Une même commande en échec n'est pas relancée sans fin. */
const MAX_FAILED_ATTEMPTS = 3;
/** Rappels avant d'accepter quand même la fin : la commande ne doit pas tourner en rond. */
const MAX_REMINDERS = 2;
/** Chaque contrôle visuel consomme du quota : il ne peut pas se répéter sans fin. */
const MAX_VISUAL_CHECKS = 4;

/**
 * Ce que le cuisinier a vérifié de son propre travail. Il ne termine pas une commande sans avoir
 * testé ce qu'il a modifié ; s'il n'y parvient pas, le bilan le dit clairement au membre.
 */
export class WorkCheck {
  readonly #unverified = new Set<string>();
  readonly #failures = new Map<string, number>();
  #failedCommand: string | null = null;
  #reminders = 0;
  #unseenDocument = false;
  #visionDown = false;
  #visualChecks = 0;

  wrote(path: string): void {
    this.#unverified.add(path);
  }

  read(path: string): void {
    if (!CODE_FILE.test(path)) this.#unverified.delete(path);
  }

  command(command: string, ok: boolean): void {
    if (ok) {
      this.#unverified.clear();
      this.#failedCommand = null;
      this.#failures.delete(command);
    } else {
      this.#failedCommand = command;
      this.#failures.set(command, (this.#failures.get(command) ?? 0) + 1);
    }
  }

  /** Une présentation a été créée ou modifiée : quelqu'un doit la regarder. */
  documentChanged(): void {
    this.#unseenDocument = true;
  }

  /** Le modèle de vision a regardé la présentation. */
  documentSeen(): void {
    this.#unseenDocument = false;
  }

  /** Le contrôle visuel n'est pas possible : ne pas insister, mais le dire dans le bilan. */
  visionUnavailable(): void {
    this.#unseenDocument = false;
    this.#visionDown = true;
  }

  /** Vrai tant qu'il reste un contrôle visuel permis ; le compte en est tenu ici. */
  allowVisualCheck(): boolean {
    if (this.#visualChecks >= MAX_VISUAL_CHECKS) return false;
    this.#visualChecks++;
    return true;
  }

  /** Cette commande a déjà échoué trop de fois : le cuisinier doit changer d'approche. */
  exhausted(command: string): boolean {
    return (this.#failures.get(command) ?? 0) >= MAX_FAILED_ATTEMPTS;
  }

  /** Ce qui manque avant de terminer, à dire au cuisinier ; `null` s'il peut terminer. */
  beforeFinish(): string | null {
    const missing = this.#missing();
    if (!missing || this.#reminders >= MAX_REMINDERS) return null;
    this.#reminders++;
    return `Pas encore : ${missing} Vérifie ton travail toi-même : lance les tests ou la compilation, exécute le script, ouvre ou relis le fichier créé, puis corrige ce qui échoue. Ne demande rien au membre. Rappelle finish ensuite. S'il n'existe vraiment aucun moyen de vérifier, rappelle finish en expliquant pourquoi dans le bilan.`;
  }

  /** Ligne à ajouter au bilan si la commande se termine sans vérification. */
  note(): string {
    const missing = this.#missing();
    const vision = this.#visionDown
      ? "\n\n**Rendu non contrôlé** : le contrôle visuel n'était pas disponible."
      : "";
    return `${missing ? `\n\n**Non vérifié** : ${missing}` : ""}${vision}`;
  }

  #missing(): string | null {
    if (this.#unseenDocument) return "la présentation n'a pas été regardée avec visual_check.";
    if (this.#failedCommand) return `la dernière commande a échoué (${this.#failedCommand}).`;
    if (this.#unverified.size > 0) {
      return `ce fichier n'a pas été vérifié après sa modification : ${[...this.#unverified].join(", ")}.`;
    }
    return null;
  }
}
