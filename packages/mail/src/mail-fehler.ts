// =============================================================================
// Versandfehler ohne Fehlertext des Providers (RT3B-K-03, MAIL-OUTBOX-001).
//
// Ein SMTP-Provider oder Relay kann beim Abweisen den Inhalt der Nachricht im
// Fehlertext zurückgeben (Inhaltsfilter, Bounce-Text): Bestätigungscodes,
// Login-Links, Empfängeradressen. Log und Persistenz der Mail-Auslieferung
// nehmen deshalb nur die Fehlerklasse, den Code (Nodemailer, z. B. EMESSAGE)
// und den SMTP-Antwortcode auf – nie `message`, `response` oder andere Texte.
// Auch diese drei Werte stammen teils aus der Fehlerinstanz; sie werden nur in
// ihrer erwarteten Form übernommen, sonst entfallen sie.
// =============================================================================

/** Log-Felder eines Versandfehlers (ohne Text des Providers). */
export interface MailFehlerFelder {
  errName: string;
  code: string | null;
  responseCode: number | null;
}

const FEHLERKLASSE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FEHLERCODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Fehlerklasse, Code und SMTP-Antwortcode eines Versandfehlers. */
export function mailFehlerFelder(error: unknown): MailFehlerFelder {
  const objekt = typeof error === 'object' && error !== null ? error : null;
  const name = error instanceof Error ? error.name : objekt ? 'Objekt' : typeof error;
  const code = (objekt as { code?: unknown } | null)?.code;
  const responseCode = (objekt as { responseCode?: unknown } | null)?.responseCode;
  return {
    errName: FEHLERKLASSE.test(name) ? name : 'Error',
    code: typeof code === 'string' && FEHLERCODE.test(code) ? code : null,
    responseCode:
      typeof responseCode === 'number' &&
      Number.isInteger(responseCode) &&
      responseCode >= 100 &&
      responseCode <= 599
        ? responseCode
        : null,
  };
}

/** Fester Vermerk für Fehlerspalten (z. B. „Versand gescheitert (Error, EMESSAGE, SMTP 550).“). */
export function mailFehlerVermerk(error: unknown): string {
  const f = mailFehlerFelder(error);
  const teile = [f.errName, f.code, f.responseCode === null ? null : `SMTP ${f.responseCode}`];
  return `Versand gescheitert (${teile.filter((t) => t !== null).join(', ')}).`;
}
