// =============================================================================
// Postausgang des Tax-CMS (TCMS Stufe 4, ADR 0001 §3.4/§7): Abruf offener
// Nachrichten und Zustellbestätigung über die zwei Endpunkte, die nur der
// Systemakteur aufrufen darf.
//
// Reiner Transport wie der Rest des Pakets: Wer zustellt, prüft und den
// Systemakteur bildet, ist allein der Zustell-Worker der kanzleikonsole
// (apps/worker/src/jobs/tcms-nachrichten.ts). Die Funktionen nehmen einen
// Client, der nur den Systemakteur bestätigt (`akteurArten: NUR_SYSTEMAKTEUR`);
// jeder andere Client oder Akteur scheitert lokal, ohne zu senden.
// Der Worker hängt nur an diesem Paket, nicht am Vertrag (keine zweite
// Workspace-Abhängigkeit), deshalb stehen auch die Typen hier.
// =============================================================================

import { ENDPUNKTE, type OffeneNachricht } from '@taxtronik/tcms-contract';
import type { TcmsErgebnis } from './antwort';
import type { TcmsAkteurAngaben, TcmsClient } from './client';
import { rufeEndpunkt } from './endpunkt';

export type { OffeneNachricht } from '@taxtronik/tcms-contract';
export { MAX_NACHRICHTEN_JE_ABRUF } from '@taxtronik/tcms-contract';

/** `GET /v1/nachrichten/offen?limit=` (1–100, älteste zuerst). */
export async function holeOffeneNachrichten(
  client: TcmsClient,
  eingabe: { akteur: TcmsAkteurAngaben; limit: number },
): Promise<TcmsErgebnis<{ nachrichten: OffeneNachricht[] }>> {
  return rufeEndpunkt(client, ENDPUNKTE.nachrichtenOffenLesen, {
    params: {},
    query: { limit: String(eingabe.limit) },
    akteur: eingabe.akteur,
  });
}

/**
 * `POST /v1/nachrichten/:nachrichtId/zugestellt` (idempotent). Ein 404
 * (unbekannt oder fremd) kommt als `TcmsNichtGefunden` beim Aufrufer an.
 */
export async function meldeNachrichtZugestellt(
  client: TcmsClient,
  eingabe: { akteur: TcmsAkteurAngaben; nachrichtId: string },
): Promise<TcmsErgebnis<{ nachrichtId: string; zugestellt: true }>> {
  return rufeEndpunkt(client, ENDPUNKTE.nachrichtZugestelltMelden, {
    params: { nachrichtId: eingabe.nachrichtId },
    akteur: eingabe.akteur,
  });
}
