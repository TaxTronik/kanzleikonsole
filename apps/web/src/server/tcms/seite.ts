import 'server-only';

// =============================================================================
// Seiten-Helfer der Tax-CMS-Oberflächen (TCMS Stufe 3).
//
// Jede TCMS-Seite beginnt mit genau einem dieser Einstiege; sie bündeln die
// Prüfkette, die sonst jede Seite selbst schreiben müsste:
//
//   /staff/clients/[id]/tcms/**  tcmsMandantSeite(id)
//     requireClientPageAccess(id) ZUERST (Guard: client-page-authz.test.ts),
//     requireModulePage('staff','tcms'), Dienst konfiguriert, dann in EINER
//     Tenant-Transaktion: Mandant im Tenant, assertTcmsAktivTx,
//     kanzleiAkteurTx(…, { mandantId }).
//   /staff/tcms/**               tcmsKanzleiSeite()  (Portfolio, Arbeitskorb:
//     Akteur + Mandantenliste über kanzleiMandantenListeTx)
//                                tcmsAdminSeite()    (Audit: nur Admin/Partner,
//     Akteur ohne Mandantenbezug)
//   /portal/tcms/**              tcmsPortalSeite()
//     portalAuth → requireModulePage('portal','tcms') → portalAkteurTx; der
//     Mandant kommt nur aus der Sitzung.
//
// Danach liest die Seite über `tcmsLesen(seite, ENDPUNKTE.x, …)`: Akteur,
// Mandanten-ID und (bei Portfolio/Arbeitskorb) die Mandantenliste setzt der
// Helfer selbst; der Aufruf läuft außerhalb jeder Transaktion. Namen löst
// `tcmsNamenLesen(seite, ids)` auf.
//
// Ergebnisse sind unterscheidbare Unions: `if (!x.ok) return <TcmsZustand
// zustand={x.zustand} />;` – TypeScript erzwingt, dass eine Seite den
// Fehlerfall behandelt, bevor sie Daten verwendet. Redirect (keine Sitzung,
// kein Mandantenzugriff) und 404 (Modul aus, Objekt nicht gefunden) laufen
// wie in der übrigen kanzleikonsole über next/navigation.
//
// Nicht-Caching: Alle Seiten rendern dynamisch (Root-Layout `force-dynamic`),
// der Client ruft mit `cache: 'no-store'`, der Dienst antwortet mit
// `Cache-Control: no-store`. Hier wird bewusst nichts mit unstable_cache oder
// 'use cache' zwischengespeichert; `cache()` gilt nur innerhalb eines Requests.
// =============================================================================

import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import type { TxClient } from '@taxtronik/db';
import { rufeEndpunkt, TcmsFehler, type TcmsAkteurAngaben } from '@taxtronik/tcms-client';
import { MandantenListeSchema, type Endpunkt, type MandantenListe } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import { requireClientPageAccess } from '@/server/auth/client-page-access';
import { portalAuth, type PortalSession } from '@/server/auth/portal';
import type { StaffSession } from '@/server/auth/staff';
import { requireStaffPage } from '@/server/auth/staff-page';
import { requireModulePage } from '@/server/settings/module-page';
import { kanzleiAkteurTx, kanzleiMandantenListeTx, portalAkteurTx } from './akteur';
import { assertTcmsAktivTx, tcmsClient, tcmsKonfiguriert } from './dienst';
import { tcmsNamen, type TcmsNamen } from './namen';
import { protokolliereTcmsFehler, seitenZustandAus, type TcmsSeitenZustand } from './zustand';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mandant aus den Daten der kanzleikonsole (Anzeige; Quelle der Namen ist nie das TCMS). */
export interface TcmsMandantInfo {
  id: string;
  name: string;
  datevNo: string | null;
}

interface SeiteBasis {
  ok: true;
  akteur: TcmsAkteurAngaben;
}

/** Mandantenbereich der Kanzlei (`/staff/clients/[id]/tcms/**`). */
export interface TcmsMandantSeite extends SeiteBasis {
  art: 'MANDANT';
  session: StaffSession;
  mandantId: string;
  mandant: TcmsMandantInfo;
  /** `/staff/clients/<id>/tcms` – Basis aller Links des Bereichs. */
  basis: string;
}

/** Kanzleiweite Seite mit Mandantenliste (Portfolio, Arbeitskorb). */
export interface TcmsKanzleiSeite extends SeiteBasis {
  art: 'KANZLEI';
  session: StaffSession;
  /** Zugreifbare Mandanten mit `bt`/`hb`, gebunden über `req.b` (ADR 0001 §3.3). */
  liste: Required<MandantenListe>;
}

/** Kanzleiweite Verwaltung (Audit): nur Admin/Partner, ohne Mandantenbezug. */
export interface TcmsAdminSeite extends SeiteBasis {
  art: 'ADMIN';
  session: StaffSession;
}

/** Portal (`/portal/tcms/**`): Mandant ausschließlich aus der Sitzung. */
export interface TcmsPortalSeite extends SeiteBasis {
  art: 'PORTAL';
  session: PortalSession;
  mandantId: string;
  mandant: TcmsMandantInfo;
}

export type TcmsSeite = TcmsMandantSeite | TcmsKanzleiSeite | TcmsAdminSeite | TcmsPortalSeite;

export type TcmsSeitenErgebnis<S extends TcmsSeite> = S | { ok: false; zustand: TcmsSeitenZustand };

function staffKontext(session: StaffSession) {
  return {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF' as const,
  };
}

/**
 * Gemeinsamer Abschluss: Verweigerung und „nicht aktiv“ werden zum
 * Seitenzustand, alles andere (auch notFound/redirect) geht weiter.
 */
async function mitZustand<S extends TcmsSeite>(
  laden: () => Promise<S>,
): Promise<TcmsSeitenErgebnis<S>> {
  if (!tcmsKonfiguriert()) return { ok: false, zustand: { art: 'NICHT_KONFIGURIERT' } };
  try {
    return await laden();
  } catch (fehler) {
    const zustand = seitenZustandAus(fehler);
    if (zustand === null || zustand === 'NICHT_GEFUNDEN') throw fehler;
    protokolliereTcmsFehler({ komponente: 'tcms-seite', endpunkt: null }, fehler);
    return { ok: false, zustand };
  }
}

async function mandantImTenant(
  tx: TxClient,
  tenantId: string,
  mandantId: string,
): Promise<TcmsMandantInfo> {
  const mandant = await tx.client.findFirst({
    where: { id: mandantId, tenantId },
    select: { id: true, name: true, datevNo: true },
  });
  if (!mandant) notFound();
  return mandant;
}

/**
 * Einstieg für `/staff/clients/[id]/tcms/**`. Muss der erste Aufruf der
 * Seite (bzw. des Layouts) sein, mit der ID aus `params`.
 */
export const tcmsMandantSeite = cache(async function tcmsMandantSeite(
  clientId: string,
): Promise<TcmsSeitenErgebnis<TcmsMandantSeite>> {
  const session = await requireClientPageAccess(clientId);
  await requireModulePage('staff', 'tcms');
  if (!UUID.test(clientId)) notFound();
  return mitZustand(() =>
    withTenantContext(staffKontext(session), async (tx) => {
      const mandant = await mandantImTenant(tx, session.user.tenantId, clientId);
      await assertTcmsAktivTx(tx, session.user.tenantId);
      const akteur = await kanzleiAkteurTx(tx, session, { mandantId: clientId });
      return {
        ok: true as const,
        art: 'MANDANT' as const,
        session,
        akteur,
        mandantId: clientId,
        mandant,
        basis: `/staff/clients/${encodeURIComponent(clientId)}/tcms`,
      };
    }),
  );
});

/** Einstieg für `/staff/tcms` (Portfolio) und Arbeitskorb-Seiten. */
export const tcmsKanzleiSeite = cache(async function tcmsKanzleiSeite(): Promise<
  TcmsSeitenErgebnis<TcmsKanzleiSeite>
> {
  const session = await requireStaffPage();
  await requireModulePage('staff', 'tcms');
  return mitZustand(() =>
    withTenantContext(staffKontext(session), async (tx) => {
      await assertTcmsAktivTx(tx, session.user.tenantId);
      const { akteur, liste } = await kanzleiMandantenListeTx(tx, session);
      return { ok: true as const, art: 'KANZLEI' as const, session, akteur, liste };
    }),
  );
});

/** Einstieg für kanzleiweite Verwaltungsseiten (Audit) unter `/staff/tcms/**`. */
export const tcmsAdminSeite = cache(async function tcmsAdminSeite(): Promise<
  TcmsSeitenErgebnis<TcmsAdminSeite>
> {
  const session = await requireStaffPage({ admin: true, deniedRedirect: '/staff/tcms' });
  await requireModulePage('staff', 'tcms');
  return mitZustand(() =>
    withTenantContext(staffKontext(session), async (tx) => {
      await assertTcmsAktivTx(tx, session.user.tenantId);
      const akteur = await kanzleiAkteurTx(tx, session);
      return { ok: true as const, art: 'ADMIN' as const, session, akteur };
    }),
  );
});

/** Einstieg für `/portal/tcms/**`. */
export const tcmsPortalSeite = cache(async function tcmsPortalSeite(): Promise<
  TcmsSeitenErgebnis<TcmsPortalSeite>
> {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  await requireModulePage('portal', 'tcms');
  const { tenantId, contactId, clientId } = session.user;
  return mitZustand(() =>
    withTenantContext({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }, async (tx) => {
      await assertTcmsAktivTx(tx, tenantId);
      const akteur = await portalAkteurTx(tx, session);
      const mandant = await mandantImTenant(tx, tenantId, clientId);
      return {
        ok: true as const,
        art: 'PORTAL' as const,
        session,
        akteur,
        mandantId: clientId,
        mandant,
      };
    }),
  );
});

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

type Eingabe<S> = S extends z.ZodType ? z.input<S> : never;
type ParamsOhneMandant<E extends Endpunkt> = Omit<z.input<E['paramsSchema']>, 'mandantId'>;

/**
 * Eingabe eines Lesezugriffs. `mandantId` (Pfad), Akteur und – bei
 * Portfolio/Arbeitskorb – der Body setzt der Helfer aus der Seite; die Seite
 * kann sie nicht überschreiben.
 */
export interface TcmsLeseEingabe<E extends Endpunkt> {
  params?: ParamsOhneMandant<E>;
  query?: Eingabe<E['querySchema']>;
}

export type TcmsLeseErgebnis<T> =
  | { ok: true; daten: T; requestId: string | null }
  | { ok: false; zustand: TcmsSeitenZustand };

/** POST-Endpunkte, die nur lesen (Body = Mandantenliste der Seite). */
const LESENDE_POST = new Set(['portfolioLesen', 'arbeitskorbLesen']);

/** Programmierfehler (falsche Seite für den Endpunkt): nie in einen Seitenzustand verwandeln. */
class TcmsSeitenFehler extends Error {
  constructor(text: string) {
    super(`tcmsLesen: ${text}`);
    this.name = 'TcmsSeitenFehler';
  }
}

function aufrufFuer<E extends Endpunkt>(
  seite: TcmsSeite,
  endpunkt: E,
  eingabe: TcmsLeseEingabe<E>,
) {
  const listenEndpunkt = endpunkt.bodySchema === MandantenListeSchema;
  if (endpunkt.methode !== 'GET' && !(listenEndpunkt && LESENDE_POST.has(endpunkt.name))) {
    throw new TcmsSeitenFehler(
      `${endpunkt.name} ist kein Lesepfad (Aktionen: server/tcms/aktion.ts)`,
    );
  }
  if (seite.art === 'PORTAL' && !endpunkt.portal) {
    throw new TcmsSeitenFehler(`${endpunkt.name} ist kein Portal-Endpunkt`);
  }
  let params: Record<string, unknown> = { ...(eingabe.params ?? {}) };
  if (endpunkt.mandantenbezogen) {
    if (seite.art !== 'MANDANT' && seite.art !== 'PORTAL') {
      throw new TcmsSeitenFehler(`${endpunkt.name} braucht eine Mandanten- oder Portalseite`);
    }
    // Der Mandant kommt nur aus der geprüften Seite (Pfad nach Zugriffsprüfung
    // bzw. Portal-Sitzung), nie aus der Eingabe.
    params = { ...params, mandantId: seite.mandantId };
  } else if ('mandantId' in params) {
    throw new TcmsSeitenFehler(`${endpunkt.name} hat keinen Mandanten im Pfad`);
  }
  let body: unknown;
  if (listenEndpunkt) {
    if (seite.art !== 'KANZLEI') {
      throw new TcmsSeitenFehler(`${endpunkt.name} braucht tcmsKanzleiSeite() (Mandantenliste)`);
    }
    body = seite.liste;
  } else if (endpunkt.bodySchema !== null) {
    throw new TcmsSeitenFehler(`${endpunkt.name} erwartet einen Body`);
  }
  return {
    params,
    ...(eingabe.query === undefined ? {} : { query: eingabe.query }),
    ...(body === undefined ? {} : { body }),
    akteur: seite.akteur,
  };
}

async function lesen<E extends Endpunkt>(
  seite: TcmsSeite,
  endpunkt: E,
  eingabe: TcmsLeseEingabe<E>,
  wennNichtGefunden: 'notFound' | 'null',
): Promise<TcmsLeseErgebnis<z.output<E['antwortSchema']> | null>> {
  const aufruf = aufrufFuer(seite, endpunkt, eingabe);
  const client = tcmsClient();
  if (!client) return { ok: false, zustand: { art: 'NICHT_KONFIGURIERT' } };
  try {
    // Außerhalb jeder Transaktion: keine DB-Verbindung wartet auf HTTP.
    const { daten, requestId } = await rufeEndpunkt(client, endpunkt, aufruf as never);
    return { ok: true, daten: daten as z.output<E['antwortSchema']>, requestId };
  } catch (fehler) {
    if (!(fehler instanceof TcmsFehler)) throw fehler;
    const zustand = seitenZustandAus(fehler);
    if (zustand === 'NICHT_GEFUNDEN') {
      if (wennNichtGefunden === 'null')
        return { ok: true, daten: null, requestId: fehler.requestId };
      notFound();
    }
    if (zustand === null) throw fehler;
    protokolliereTcmsFehler({ komponente: 'tcms-seite', endpunkt: endpunkt.name }, fehler);
    return { ok: false, zustand };
  }
}

/**
 * Liest einen Endpunkt für die Seite. 404 des Dienstes → notFound() (keine
 * Existenz verraten); 403 → „Kein Zugriff“; Ausfall → „nicht erreichbar“.
 */
export async function tcmsLesen<E extends Endpunkt>(
  seite: TcmsSeite,
  endpunkt: E,
  eingabe: TcmsLeseEingabe<E> = {},
): Promise<TcmsLeseErgebnis<z.output<E['antwortSchema']>>> {
  return lesen(seite, endpunkt, eingabe, 'notFound') as Promise<
    TcmsLeseErgebnis<z.output<E['antwortSchema']>>
  >;
}

/**
 * Wie `tcmsLesen`, aber 404 ergibt `daten: null` – für Seiten, die „noch
 * nicht angelegt“ selbst darstellen (Cockpit: Mandant nicht im Tax-CMS).
 */
export async function tcmsLesenOptional<E extends Endpunkt>(
  seite: TcmsSeite,
  endpunkt: E,
  eingabe: TcmsLeseEingabe<E> = {},
): Promise<TcmsLeseErgebnis<z.output<E['antwortSchema']> | null>> {
  return lesen(seite, endpunkt, eingabe, 'null');
}

// ---------------------------------------------------------------------------
// Daten der kanzleikonsole
// ---------------------------------------------------------------------------

/**
 * Kurze Tenant-Transaktion mit dem Akteur der Seite für Daten der
 * kanzleikonsole (Kontakte, Namen, Dokumente) – getrennt vom Dienstaufruf,
 * nie um ihn herum.
 */
export function tcmsTenantLesen<T>(seite: TcmsSeite, lesen: (tx: TxClient) => Promise<T>) {
  if (seite.art === 'PORTAL') {
    const { tenantId, contactId } = seite.session.user;
    return withTenantContext({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }, lesen);
  }
  return withTenantContext(staffKontext(seite.session), lesen);
}

// ---------------------------------------------------------------------------
// Namen
// ---------------------------------------------------------------------------

/**
 * Namen zu Personen-IDs aus TCMS-Antworten, in einer eigenen kurzen
 * Tenant-Transaktion nach dem Dienstaufruf. Jede ID wird als Mitarbeiter des
 * Tenants und – bei Mandanten- und Portalseiten – als Kontakt genau dieses
 * Mandanten gesucht (die Antwort sagt nicht, welche Art von Person gemeint ist).
 */
export async function tcmsNamenLesen(
  seite: TcmsSeite,
  ids: Iterable<string | null | undefined>,
): Promise<TcmsNamen> {
  const liste = [...ids];
  const tenantId = seite.session.user.tenantId;
  const kontakte =
    seite.art === 'MANDANT' || seite.art === 'PORTAL'
      ? { kontakte: { mandantId: seite.mandantId, ids: liste } }
      : {};
  return tcmsTenantLesen(seite, (tx) => tcmsNamen(tx, { tenantId, staffIds: liste, ...kontakte }));
}
