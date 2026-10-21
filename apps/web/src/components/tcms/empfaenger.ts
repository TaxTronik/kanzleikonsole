// =============================================================================
// Empfänger von Anforderungen, die ein Kontakt im Portal per Code bestätigt
// (Freigabe, Risikoakzeptanz, Kenntnisnahme, Zielfreigabe; kk-tcms-s11 Punkt 4,
// Produktentscheidung Rey Koxha, 21.10.2026): Kontakte ohne aktiven
// Portalzugang dürfen Rollen haben, erscheinen in Auswahllisten aber nur
// gesperrt und mit festem Hinweis. Die Aktion prüft dasselbe erneut
// (server/tcms/personen.ts, freigabeEmpfaengerTx).
// =============================================================================

/** Hinweis an einem Kontakt ohne aktiven Portalzugang. */
export const OHNE_PORTALZUGANG = 'ohne Portalzugang – kann nicht freigeben';

/** Grund einer gesperrten Anforderung, wenn keine wählbare Person Portalzugang hat. */
export const KEIN_EMPFAENGER_MIT_PORTALZUGANG =
  'Keine der infrage kommenden Personen hat einen aktiven Portalzugang – ohne Portalzugang kann niemand freigeben.';

export interface Empfaenger {
  id: string;
  name: string;
  /** Aktiver Portalzugang (kanzleikonsole). */
  portal: boolean;
}

/** Personen mit Kennzeichen aus der Menge der Kontakte mit Portalzugang (IDs klein). */
export function mitPortalzugang<P extends { id: string }>(
  personen: readonly P[],
  zugang: ReadonlySet<string>,
): Array<P & { portal: boolean }> {
  return personen.map((p) => ({ ...p, portal: zugang.has(p.id.toLowerCase()) }));
}

/** Text einer Auswahloption: Name, Zusatz und – ohne Zugang – der Hinweis. */
export function empfaengerLabel(name: string, portal: boolean, zusatz = ''): string {
  return `${name}${zusatz}${portal ? '' : ` (${OHNE_PORTALZUGANG})`}`;
}

/** Vorauswahl nur bei genau einer wählbaren Person. */
export function einzigerEmpfaenger(personen: readonly Empfaenger[]): string {
  const waehlbar = personen.filter((p) => p.portal);
  return waehlbar.length === 1 ? waehlbar[0]!.id : '';
}
