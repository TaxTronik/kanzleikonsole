import 'server-only';

// =============================================================================
// ÜBERGANG (TCMS Stufe 3, Bereich D): Einstieg der Route-Handler für
// Datei-Abrufe, bis der gemeinsame Baustein `server/tcms/route.ts` aus
// Bereich C (Commit „shared: add the tax-cms route handler entry for file
// downloads“) in diesem Branch ist.
//
// Gebaut gegen dessen Schnittstelle, damit die Handler beim Zusammenführen
// nur den Import wechseln:
//   tcmsMandantRoute(id) / tcmsPortalRoute() → { ok: true, art, session,
//     akteur, mandantId } | { ok: false, antwort }
//   tcmsRouteLesen(route, ENDPUNKTE.x, { params }) → { ok: true, daten,
//     requestId } | { ok: false, antwort }
//   tcmsRouteAntwort(art) → feste JSON-Antwort (Codes und Texte wie dort)
// Die Handler nutzen nur diese Felder (nicht `basis`, `mandant` o. Ä.).
//
// Bewusst KEINE eigene Prüfkette: Die Einstiege rufen genau die Seiten-Helfer
// (`tcmsMandantSeite` bzw. `tcmsPortalSeite`: Sitzung bzw. Mandantenzugriff
// zuerst, Modul `tcms`, Konfiguration, Aktivierung, Akteur) und übersetzen
// nur deren Zustand in eine HTTP-Antwort. Unterschied bis zum Wechsel: ohne
// Sitzung bzw. ohne Mandantenzugriff leiten die Seiten-Helfer weiter (Login
// bzw. 404-Seite) statt 401/404-JSON.
//
// Beim Zusammenführen mit Bereich C: Handler nach app/api/staff/… bzw.
// app/api/portal/… verschieben (Guard tcms-route-authz.test.ts), Import auf
// `@/server/tcms/route` umstellen, diese Datei löschen (Diff im Bericht).
// =============================================================================

import { NextResponse } from 'next/server';
import type { Endpunkt } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import {
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsPortalSeite,
  type TcmsLeseEingabe,
  type TcmsMandantSeite,
  type TcmsPortalSeite,
} from '@/server/tcms/seite';
import type { TcmsSeitenZustand } from '@/server/tcms/zustand';

export type TcmsRoute = TcmsMandantSeite | TcmsPortalSeite;

export interface TcmsRouteAbbruch {
  ok: false;
  antwort: NextResponse;
}

export type TcmsRouteErgebnis<R extends TcmsRoute> = R | TcmsRouteAbbruch;

/** Feste Antworten (wie TCMS_ROUTE_ANTWORTEN in server/tcms/route.ts; nie Texte des Dienstes). */
export const TCMS_ROUTE_ANTWORTEN = {
  NICHT_GEFUNDEN: { status: 404, error: 'not_found', message: 'Nicht gefunden.' },
  KEIN_RECHT: {
    status: 403,
    error: 'forbidden',
    message: 'Sie haben keinen Zugriff auf diese Datei des Tax-CMS.',
  },
  ANFRAGE_UNGUELTIG: {
    status: 400,
    error: 'invalid_request',
    message: 'Die Anfrage konnte nicht bearbeitet werden.',
  },
  NICHT_ERREICHBAR: {
    status: 503,
    error: 'tcms_unavailable',
    message: 'Das Tax-CMS ist derzeit nicht erreichbar. Bitte versuchen Sie es später erneut.',
  },
} as const;

export type TcmsRouteAntwortArt = keyof typeof TCMS_ROUTE_ANTWORTEN;

/** Kopfzeilen jeder Antwort ohne Datei (kein Caching, kein Sniffing). */
export const TCMS_ROUTE_KOPF: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Feste JSON-Antwort (auch für die Abgleichsfehler der Bereichs-Helfer). */
export function tcmsRouteAntwort(art: TcmsRouteAntwortArt): NextResponse {
  const { status, error, message } = TCMS_ROUTE_ANTWORTEN[art];
  return NextResponse.json({ error, message }, { status, headers: TCMS_ROUTE_KOPF });
}

const ZUSTAND_ANTWORT: Readonly<Record<TcmsSeitenZustand['art'], TcmsRouteAntwortArt>> = {
  // Modul aus, Dienst nicht konfiguriert, Tax-CMS inaktiv: ohne Existenzhinweis.
  NICHT_KONFIGURIERT: 'NICHT_GEFUNDEN',
  KEIN_ZUGRIFF: 'KEIN_RECHT',
  NICHT_ERREICHBAR: 'NICHT_ERREICHBAR',
  ANFRAGE_UNGUELTIG: 'ANFRAGE_UNGUELTIG',
};

/** Seitenzustand → feste Antwort. */
export function tcmsRouteZustand(zustand: TcmsSeitenZustand): NextResponse {
  return tcmsRouteAntwort(ZUSTAND_ANTWORT[zustand.art]);
}

/** `/staff/clients/[id]/tcms/**`: Einstieg wie tcmsMandantSeite (erster Aufruf des Handlers). */
export async function tcmsMandantRoute(
  mandantId: string,
): Promise<TcmsRouteErgebnis<TcmsMandantSeite>> {
  const seite = await tcmsMandantSeite(mandantId);
  return seite.ok ? seite : { ok: false, antwort: tcmsRouteZustand(seite.zustand) };
}

/** `/portal/tcms/**`: Einstieg wie tcmsPortalSeite (Mandant nur aus der Sitzung). */
export async function tcmsPortalRoute(): Promise<TcmsRouteErgebnis<TcmsPortalSeite>> {
  const seite = await tcmsPortalSeite();
  return seite.ok ? seite : { ok: false, antwort: tcmsRouteZustand(seite.zustand) };
}

export type TcmsRouteLeseErgebnis<T> =
  | { ok: true; daten: T; requestId: string | null }
  | TcmsRouteAbbruch;

/**
 * Liest über den Seiten-Helfer (Mandant und Akteur aus der geprüften Route,
 * Portal nur Portal-Endpunkte). 404 des Dienstes → 404 ohne Existenzhinweis.
 */
export async function tcmsRouteLesen<E extends Endpunkt>(
  route: TcmsRoute,
  endpunkt: E,
  eingabe: Pick<TcmsLeseEingabe<E>, 'params'> = {},
): Promise<TcmsRouteLeseErgebnis<z.output<E['antwortSchema']>>> {
  const ergebnis = await tcmsLesenOptional(route, endpunkt, eingabe);
  if (!ergebnis.ok) return { ok: false, antwort: tcmsRouteZustand(ergebnis.zustand) };
  if (ergebnis.daten === null) return { ok: false, antwort: tcmsRouteAntwort('NICHT_GEFUNDEN') };
  return { ok: true, daten: ergebnis.daten, requestId: ergebnis.requestId };
}
