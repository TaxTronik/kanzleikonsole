/** Error whose message may safely be returned by a server action. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

/** Keine (gültige) Sitzung — die Meldung ist UI-tauglich. */
export class UnauthorizedError extends Error {
  constructor(message = 'Nicht eingeloggt.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Fehlende Berechtigung — die Meldung ist UI-tauglich. */
export class ForbiddenError extends Error {
  constructor(message = 'Nur ADMIN/PARTNER.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
