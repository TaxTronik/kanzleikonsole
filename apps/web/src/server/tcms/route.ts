import 'server-only';

// =============================================================================
// Route-Handler-Einstieg der Tax-CMS-Oberflächen (TCMS Stufe 3, gemeinsamer
// Baustein der Bereiche C und D).
//
// Datei-Abrufe (Nachweise einer Durchführung, Anlagen einer Meldung) laufen
// über Route Handler (`app/api/**/tcms/**/route.ts`), nicht über Seiten. Für
// sie gilt dieselbe Prüfkette wie für die Seiten-Helfer (server/tcms/seite.ts),
// nur mit HTTP-Antworten statt Redirect/404-Seite:
//
//   tcmsMandantRoute(id)   /api/staff/**/tcms/**
//     staffAuth ZUERST → gültige Mandanten-ID → Modulbereich `tcms` →
//     Dienst konfiguriert → in EINER Tenant-Transaktion: Mandant im Tenant,
//     canAccessClientTx (ACCESS-CLIENT-MODE-001, wie die Dokumentauslieferung),
//     Tax-CMS aktiv, kanzleiAkteurTx(…, { mandantId }).
//   tcmsPortalRoute()      /api/portal/**/tcms/**
//     portalAuth ZUERST → Modulbereich `tcms` → Dienst konfiguriert → Tax-CMS
//     aktiv, portalAkteurTx; der Mandant kommt nur aus der Sitzung.
//
// Danach liest der Handler über `tcmsRouteLesen(route, ENDPUNKTE.x, …)` – nur
// GET-Endpunkte mit Mandant im Pfad, deren `akteure` die Art der Route nennen
// (Portal: MANDANT, Kanzlei: KANZLEI); Akteur und `mandantId` setzt der Helfer,
// der Handler gibt nur die übrigen Pfadparameter an. Die Bytes liefert danach
// ausschließlich die Dokumentauslieferung der kanzleikonsole
// (server/documents/delivery.ts) mit ihren eigenen Rechten und dem
// SHA-256-Abgleich gegen den Verweis des Tax-CMS (Bereichs-Helfer).
//
// Antworten: `{ ok: false, antwort }` mit fester JSON-Antwort (`error`-Code und
// deutscher Text, nie ein Text des Dienstes), `Cache-Control: private,
// no-store`. Ohne Sitzung 401; fremder, unbekannter oder nicht zugänglicher
// Mandant, Modul aus, Dienst nicht konfiguriert oder Tax-CMS inaktiv: 404 ohne
// Hinweis auf die Existenz; veraltete Sitzung 401 („neu anmelden“); 403 des
// Dienstes 403; Ausfall 503 mit Vorgangsnummer.
//
// Guards: src/__tests__/tcms-route-authz.test.ts (jeder Route Handler unter
// `/tcms/` beginnt mit genau einem dieser Einstiege, nur GET, kein direkter
// Client) und api-route-authz.test.ts (erkennt die Einstiege nur als Import
// aus diesem Modul).
// =============================================================================

import { NextResponse } from 'next/server';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import {
  rufeEndpunkt,
  TcmsFehler,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
  type TcmsAkteurAngaben,
} from '@taxtronik/tcms-client';
import type { Endpunkt } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import { isModuleAreaEnabled } from '@/lib/module-registry';
import { canAccessClientTx } from '@/server/auth/rbac';
import { portalAuth, type PortalSession } from '@/server/auth/portal';
import { staffAuth, type StaffSession } from '@/server/auth/staff';
import { log } from '@/server/logger';
import { readModules } from '@/server/settings/modules';
import { kanzleiAkteurTx, portalAkteurTx, TcmsAkteurVerweigert } from './akteur';
import { tcmsAktivTx, tcmsClient, tcmsKonfiguriert } from './dienst';
import { tcmsLogFelder } from './zustand';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** requestId nur im Format des Clients (wie server/tcms/zustand.ts). */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Mandantenbereich der Kanzlei (`/api/staff/…/tcms/…`). */
export interface TcmsMandantRoute {
  ok: true;
  art: 'MANDANT';
  session: StaffSession;
  akteur: TcmsAkteurAngaben;
  /** Geprüfter Mandant (kanonisch klein), einzige Quelle für `mandantId` im Pfad. */
  mandantId: string;
}

/** Portal (`/api/portal/…/tcms/…`): Mandant ausschließlich aus der Sitzung. */
export interface TcmsPortalRoute {
  ok: true;
  art: 'PORTAL';
  session: PortalSession;
  akteur: TcmsAkteurAngaben;
  mandantId: string;
}

export type TcmsRoute = TcmsMandantRoute | TcmsPortalRoute;

/** Abbruch mit fertiger HTTP-Antwort. */
export interface TcmsRouteAbbruch {
  ok: false;
  antwort: NextResponse;
}

export type TcmsRouteErgebnis<R extends TcmsRoute> = R | TcmsRouteAbbruch;

/** Feste Antworten der Route-Einstiege (Code, Status, Text; nie Texte des Dienstes). */
export const TCMS_ROUTE_ANTWORTEN = {
  NICHT_ANGEMELDET: { status: 401, error: 'unauthorized', message: 'Bitte melden Sie sich an.' },
  NEU_ANMELDEN: {
    status: 401,
    error: 'session_stale',
    message: 'Bitte melden Sie sich erneut an, damit Ihre aktuellen Rechte gelten.',
  },
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

/** Kopfzeilen jeder Antwort eines TCMS-Route-Handlers ohne Datei. */
export const TCMS_ROUTE_KOPF: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * Feste JSON-Antwort (auch für Bereichs-Helfer, z. B. Abgleichsfehler eines
 * Nachweises). `requestId` des Dienstes nur im Format des Clients.
 */
export function tcmsRouteAntwort(
  art: TcmsRouteAntwortArt,
  requestId: string | null = null,
): NextResponse {
  const { status, error, message } = TCMS_ROUTE_ANTWORTEN[art];
  const vorgang = requestId !== null && REQUEST_ID.test(requestId) ? { requestId } : {};
  return NextResponse.json({ error, message, ...vorgang }, { status, headers: TCMS_ROUTE_KOPF });
}

function abbruch(art: TcmsRouteAntwortArt, requestId: string | null = null): TcmsRouteAbbruch {
  return { ok: false, antwort: tcmsRouteAntwort(art, requestId) };
}

const NEU_ANMELDEN_GRUENDE: ReadonlySet<TcmsAkteurVerweigert['grund']> = new Set([
  'SITZUNG_ABGELAUFEN',
  'SITZUNG_VERALTET',
]);

function protokolliere(endpunkt: string | null, fehler: unknown): void {
  const stoerung =
    fehler instanceof TcmsNichtVerfuegbar ||
    fehler instanceof TcmsProtokollFehler ||
    fehler instanceof TcmsNichtAuthentifiziert;
  const zeile = { component: 'tcms-route', endpunkt, ...tcmsLogFelder(fehler) };
  if (stoerung) log.warn(zeile, 'TCMS-Aufruf gestört');
  else log.info(zeile, 'TCMS-Aufruf abgewiesen');
}

/** Keine Bestätigung → veraltete Sitzung 401, sonst 404 (keine Existenz verraten). */
function verweigerung(fehler: TcmsAkteurVerweigert): TcmsRouteAbbruch {
  protokolliere(null, fehler);
  return abbruch(NEU_ANMELDEN_GRUENDE.has(fehler.grund) ? 'NEU_ANMELDEN' : 'NICHT_GEFUNDEN');
}

/**
 * Einstieg für Route Handler unter `/api/staff/…/tcms/…` mit Mandant im
 * Pfad. Muss der erste Aufruf des Handlers sein (nach `await params`).
 */
export async function tcmsMandantRoute(
  clientId: string,
): Promise<TcmsRouteErgebnis<TcmsMandantRoute>> {
  const session = await staffAuth();
  if (!session?.user) return abbruch('NICHT_ANGEMELDET');
  if (typeof clientId !== 'string' || !UUID.test(clientId)) return abbruch('NICHT_GEFUNDEN');
  const mandantId = clientId.toLowerCase();
  const { tenantId, staffId } = session.user;
  const kontext = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  if (!isModuleAreaEnabled(await readModules(kontext), 'tcms')) return abbruch('NICHT_GEFUNDEN');
  if (!tcmsKonfiguriert()) return abbruch('NICHT_GEFUNDEN');
  try {
    return await withTenantContext(
      kontext,
      async (tx): Promise<TcmsRouteErgebnis<TcmsMandantRoute>> => {
        const mandant = await tx.client.findFirst({
          where: { id: mandantId, tenantId },
          select: { id: true },
        });
        if (!mandant) return abbruch('NICHT_GEFUNDEN');
        // Zugriff nach den Regeln der kanzleikonsole vor jeder Bestätigung.
        if (!(await canAccessClientTx(tx, session, mandantId))) return abbruch('NICHT_GEFUNDEN');
        if (!(await tcmsAktivTx(tx, tenantId))) return abbruch('NICHT_GEFUNDEN');
        const akteur = await kanzleiAkteurTx(tx, session, { mandantId });
        return { ok: true, art: 'MANDANT', session, akteur, mandantId };
      },
    );
  } catch (fehler) {
    if (fehler instanceof TcmsAkteurVerweigert) return verweigerung(fehler);
    throw fehler;
  }
}

/** Einstieg für Route Handler unter `/api/portal/…/tcms/…`; Mandant aus der Sitzung. */
export async function tcmsPortalRoute(): Promise<TcmsRouteErgebnis<TcmsPortalRoute>> {
  const session = await portalAuth();
  if (!session?.user) return abbruch('NICHT_ANGEMELDET');
  const { tenantId, contactId } = session.user;
  const kontext = { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' as const };
  if (!isModuleAreaEnabled(await readModules(kontext), 'tcms')) return abbruch('NICHT_GEFUNDEN');
  if (!tcmsKonfiguriert()) return abbruch('NICHT_GEFUNDEN');
  try {
    return await withTenantContext(
      kontext,
      async (tx): Promise<TcmsRouteErgebnis<TcmsPortalRoute>> => {
        if (!(await tcmsAktivTx(tx, tenantId))) return abbruch('NICHT_GEFUNDEN');
        const akteur = await portalAkteurTx(tx, session);
        const mandantId = akteur.cli?.id;
        if (!mandantId) return abbruch('NICHT_GEFUNDEN');
        return { ok: true, art: 'PORTAL', session, akteur, mandantId };
      },
    );
  } catch (fehler) {
    if (fehler instanceof TcmsAkteurVerweigert) return verweigerung(fehler);
    throw fehler;
  }
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/** Programmierfehler (falscher Endpunkt für einen Route Handler): nie als Antwort abbilden. */
class TcmsRouteFehler extends Error {
  constructor(text: string) {
    super(`tcmsRouteLesen: ${text}`);
    this.name = 'TcmsRouteFehler';
  }
}

export interface TcmsRouteLeseEingabe<E extends Endpunkt> {
  /** Pfadparameter außer `mandantId` (den setzt der Helfer aus der geprüften Route). */
  params?: Omit<z.input<E['paramsSchema']>, 'mandantId'>;
}

export type TcmsRouteLeseErgebnis<T> =
  | { ok: true; daten: T; requestId: string | null }
  | TcmsRouteAbbruch;

/**
 * Liest einen GET-Endpunkt mit Mandant im Pfad für die geprüfte Route,
 * außerhalb jeder Transaktion. 404 und lokal ungültige Parameter → 404,
 * 403 → 403, 400/409 → 400, Ausfall → 503 mit Vorgangsnummer.
 */
export async function tcmsRouteLesen<E extends Endpunkt>(
  route: TcmsRoute,
  endpunkt: E,
  eingabe: TcmsRouteLeseEingabe<E> = {},
): Promise<TcmsRouteLeseErgebnis<z.output<E['antwortSchema']>>> {
  if (endpunkt.methode !== 'GET' || endpunkt.bodySchema !== null) {
    throw new TcmsRouteFehler(`${endpunkt.name} ist kein Lesepfad`);
  }
  if (!endpunkt.mandantenbezogen) {
    throw new TcmsRouteFehler(`${endpunkt.name} hat keinen Mandanten im Pfad`);
  }
  // TCMS Stufe 4 (wie seite.ts/aktion.ts): Zulassung nur aus `akteure` des
  // Registers (`portal` ist abgeleitet). Portal-Routen erreichen nur
  // MANDANT-Endpunkte, Kanzlei-Routen nur KANZLEI-Endpunkte.
  const portalRoute = route.art === 'PORTAL';
  if (!endpunkt.akteure.includes(portalRoute ? 'MANDANT' : 'KANZLEI')) {
    throw new TcmsRouteFehler(
      `${endpunkt.name} ist kein ${portalRoute ? 'Portal' : 'Kanzlei'}-Endpunkt`,
    );
  }
  const client = tcmsClient();
  if (!client) return abbruch('NICHT_GEFUNDEN');
  // Der Mandant kommt nur aus der geprüften Route, nie aus der Eingabe.
  const params = { ...(eingabe.params ?? {}), mandantId: route.mandantId };
  try {
    const { daten, requestId } = await rufeEndpunkt(client, endpunkt, {
      params,
      akteur: route.akteur,
    } as never);
    return { ok: true, daten: daten as z.output<E['antwortSchema']>, requestId };
  } catch (fehler) {
    if (!(fehler instanceof TcmsFehler)) throw fehler;
    protokolliere(endpunkt.name, fehler);
    if (fehler instanceof TcmsNichtGefunden) return abbruch('NICHT_GEFUNDEN');
    if (fehler instanceof TcmsUngueltig && fehler.lokal) return abbruch('NICHT_GEFUNDEN');
    if (fehler instanceof TcmsNichtBerechtigt) return abbruch('KEIN_RECHT');
    if (fehler instanceof TcmsUngueltig || fehler.status === 409) {
      return abbruch('ANFRAGE_UNGUELTIG', fehler.requestId);
    }
    return abbruch('NICHT_ERREICHBAR', fehler.requestId);
  }
}
