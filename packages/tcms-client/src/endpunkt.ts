// =============================================================================
// Typisierter Aufruf eines Eintrags aus dem Endpunktregister des TCMS-Vertrags
// (`ENDPUNKTE` in @taxtronik/tcms-contract, TCMS Stufe 2).
//
// Das Register ist die eine Quelle für Methode, Pfad und Schemas; der Dienst
// registriert seine Routen daraus und startet nicht bei Abweichung. Hier wird
// es in den generischen `aufruf` übersetzt, mit lokalen Vorprüfungen, die der
// Dienst ohnehin erzwingt (Verteidigung in der Tiefe, kein Ersatz):
//   - Pfadparameter mit `paramsSchema` (streng, z. B. UUIDs) vor dem Senden;
//   - Mandantenkontakte nur auf Endpunkten mit `portal: true`;
//   - `health` (ohne Akteur) nur über `client.health()`.
// Die Typen der Eingaben und des Ergebnisses folgen aus den Schemas.
// =============================================================================

import type { Endpunkt } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import type { TcmsErgebnis } from './antwort';
import type { TcmsAkteurAngaben, TcmsClient } from './client';
import { TcmsUngueltig } from './fehler';
import type { TcmsQuery } from './ziel';

type Eingabe<S> = S extends z.ZodType ? z.input<S> : never;

export interface TcmsEndpunktEingabe<E extends Endpunkt> {
  params: z.input<E['paramsSchema']>;
  query?: Eingabe<E['querySchema']>;
  body?: Eingabe<E['bodySchema']>;
  akteur: TcmsAkteurAngaben;
  zeitlimitMs?: number;
  maxAntwortBytes?: number;
}

function lokal(feld: string, grund: string): TcmsUngueltig {
  return new TcmsUngueltig({ [feld]: [grund] }, { lokal: true });
}

/** Pfadparameter streng prüfen und als Zeichenketten weitergeben. */
function pfadParameter(endpunkt: Endpunkt, params: unknown): Record<string, string> {
  const geprueft = endpunkt.paramsSchema.safeParse(params);
  if (!geprueft.success || geprueft.data === null || typeof geprueft.data !== 'object') {
    throw lokal('params', 'passen nicht zum Endpunkt');
  }
  const werte: Record<string, string> = {};
  for (const [name, wert] of Object.entries(geprueft.data as Record<string, unknown>)) {
    if (typeof wert !== 'string') throw lokal(`params.${name}`, 'muss Text sein');
    werte[name] = wert;
  }
  return werte;
}

/**
 * Ruft einen Registereintrag auf. Beispiel:
 * `rufeEndpunkt(client, ENDPUNKTE.kontextLesen, { params: { mandantId }, akteur })`.
 */
export async function rufeEndpunkt<E extends Endpunkt>(
  client: TcmsClient,
  endpunkt: E,
  eingabe: TcmsEndpunktEingabe<E>,
): Promise<TcmsErgebnis<z.output<E['antwortSchema']>>> {
  if (!endpunkt.akteur) throw lokal('endpunkt', 'ohne Akteur nur über health()');
  if (eingabe.akteur.knd === 'MANDANT' && !endpunkt.portal) {
    throw lokal('akteur.knd', 'Mandantenkontakt auf Kanzlei-Endpunkt');
  }
  const params = pfadParameter(endpunkt, eingabe.params);
  return client.aufruf({
    methode: endpunkt.methode,
    pfad: endpunkt.pfad,
    params,
    ...(endpunkt.querySchema ? { querySchema: endpunkt.querySchema } : {}),
    ...(endpunkt.bodySchema ? { bodySchema: endpunkt.bodySchema } : {}),
    antwortSchema: endpunkt.antwortSchema,
    ...(eingabe.query === undefined ? {} : { query: eingabe.query as TcmsQuery }),
    ...(eingabe.body === undefined ? {} : { body: eingabe.body }),
    akteur: eingabe.akteur,
    ...(eingabe.zeitlimitMs === undefined ? {} : { zeitlimitMs: eingabe.zeitlimitMs }),
    ...(eingabe.maxAntwortBytes === undefined ? {} : { maxAntwortBytes: eingabe.maxAntwortBytes }),
  }) as Promise<TcmsErgebnis<z.output<E['antwortSchema']>>>;
}
