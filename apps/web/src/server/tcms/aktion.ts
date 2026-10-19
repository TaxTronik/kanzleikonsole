import 'server-only';

// =============================================================================
// Aktions-Helfer der Tax-CMS-Oberflächen (TCMS Stufe 3).
//
// tcmsKanzleiAktion / tcmsPortalAktion bauen auf staffAction/portalAction auf
// (Gate mit `module: 'tcms'`, Feldfehler aus `parse`, zentrales
// Fehler-Mapping) und erzwingen die Reihenfolge jeder schreibenden
// TCMS-Aktion:
//
//   1. Gate (Sitzung, Modul `tcms`, optional Admin/Partner).
//   2. EINE Tenant-Transaktion: assertTcmsAktivTx, Akteur aus der geprüften
//      Sitzung (kanzleiAkteurTx mit dem Mandanten der Aktion bzw.
//      portalAkteurTx), optional `vorbereiten` – Daten der kanzleikonsole
//      laden und prüfen (Personen: server/tcms/personen.ts, Stammdaten).
//   3. Dienstaufruf AUSSERHALB der Transaktion über `dienst.rufe(ENDPUNKTE.x,
//      …)`: Akteur und Mandant setzt der Helfer, die Aktion kann sie nicht
//      überschreiben.
//   4. Fehler → ActionResult über eine feste Tabelle (server/tcms/zustand.ts):
//      Feldfehler mit deutschen Standardtexten, Konflikt → „Wurde
//      zwischenzeitlich geändert – bitte neu laden“, 403 → fester Text je
//      `keinRecht`, Ausfall → feste Meldung (bei Schreibzugriffen ohne
//      verlässliche Antwort: Ausgang offen).
//   5. Revalidierung nur des TCMS-Bereichs: `/staff/clients/<id>/tcms`
//      (Layout) und `/staff/tcms` bzw. `/portal/tcms` (Layout) – nie das
//      Layout aller Mandantenakten (Guard: client-revalidation-scope.test.ts).
//
// Was der Dienst entscheidet (Rechte, Vier-Augen, §-153, Vertraulichkeit,
// Statusübergänge), prüft die kanzleikonsole nicht nach; sie bildet die
// Antwort ab. Guards: server-action-authz.test.ts und server-action-style.test.ts
// erkennen beide Helfer nur als Import aus diesem Modul.
// =============================================================================

import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import type { TxClient } from '@taxtronik/db';
import { rufeEndpunkt, type TcmsAkteurAngaben, type TcmsErgebnis } from '@taxtronik/tcms-client';
import { MandantenListeSchema, type Endpunkt } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import type {
  ActionOutcome,
  ActionParseResult,
  ActionRunResult,
} from '@/server/actions/action-runner';
import { portalAction, type PortalCtx } from '@/server/actions/portal-action';
import { staffAction, type StaffCtx } from '@/server/actions/staff-action';
import { kanzleiAkteurTx, portalAkteurTx } from './akteur';
import { assertTcmsAktivTx, tcmsClient, TcmsInaktivError } from './dienst';
import { aktionsFehlerAus, protokolliereTcmsFehler, type TcmsAktionsAbbildung } from './zustand';

type Eingabe<S> = S extends z.ZodType ? z.input<S> : never;

/** Eingabe eines Dienstaufrufs in einer Aktion; `mandantId` setzt der Helfer. */
export interface TcmsAktionsEingabe<E extends Endpunkt> {
  params?: Omit<z.input<E['paramsSchema']>, 'mandantId'>;
  query?: Eingabe<E['querySchema']>;
  body?: Eingabe<E['bodySchema']>;
}

/** An den Akteur und Mandanten der Aktion gebundener Aufruf. */
export interface TcmsDienst {
  rufe<E extends Endpunkt>(
    endpunkt: E,
    eingabe?: TcmsAktionsEingabe<E>,
  ): Promise<TcmsErgebnis<z.output<E['antwortSchema']>>>;
}

/** Programmierfehler (falscher Endpunkt für die Aktion): nie als Nutzerfehler abbilden. */
class TcmsAktionsFehler extends Error {
  constructor(text: string) {
    super(`tcms-aktion: ${text}`);
    this.name = 'TcmsAktionsFehler';
  }
}

interface Bindung {
  akteur: TcmsAkteurAngaben;
  /** Mandant der Aktion (geprüft durch den Akteur) oder null (kanzleiweit). */
  mandantId: string | null;
  portal: boolean;
  /** Name des zuletzt gerufenen Endpunkts (Protokoll). */
  zuletzt: { name: string | null };
}

function dienstFuer(bindung: Bindung): TcmsDienst {
  return {
    async rufe(endpunkt, eingabe = {}) {
      if (bindung.portal && !endpunkt.portal) {
        throw new TcmsAktionsFehler(`${endpunkt.name} ist kein Portal-Endpunkt`);
      }
      if (endpunkt.bodySchema === MandantenListeSchema) {
        throw new TcmsAktionsFehler(`${endpunkt.name} ist ein Lesepfad (tcmsLesen)`);
      }
      if (endpunkt.mandantenbezogen !== (bindung.mandantId !== null)) {
        throw new TcmsAktionsFehler(
          bindung.mandantId === null
            ? `${endpunkt.name} braucht eine Aktion mit Mandant`
            : `${endpunkt.name} ist nicht mandantenbezogen`,
        );
      }
      const client = tcmsClient();
      if (!client) throw new TcmsInaktivError();
      bindung.zuletzt.name = endpunkt.name;
      const params = {
        ...(eingabe.params ?? {}),
        ...(bindung.mandantId === null ? {} : { mandantId: bindung.mandantId }),
      };
      return rufeEndpunkt(client, endpunkt, {
        params,
        ...(eingabe.query === undefined ? {} : { query: eingabe.query }),
        ...(eingabe.body === undefined ? {} : { body: eingabe.body }),
        akteur: bindung.akteur,
      } as never) as Promise<TcmsErgebnis<z.output<(typeof endpunkt)['antwortSchema']>>>;
    },
  };
}

function abbilden(fehler: unknown, abbildung: TcmsAktionsAbbildung, zuletzt: string | null) {
  const ergebnis = aktionsFehlerAus(fehler, { ...abbildung, schreibend: true });
  if (ergebnis) protokolliereTcmsFehler({ komponente: 'tcms-aktion', endpunkt: zuletzt }, fehler);
  return ergebnis;
}

function istFehlschlag(wert: unknown): boolean {
  return typeof wert === 'object' && wert !== null && (wert as { ok?: unknown }).ok === false;
}

// ---------------------------------------------------------------------------
// Kanzlei
// ---------------------------------------------------------------------------

export interface TcmsKanzleiKontext {
  g: StaffCtx;
  akteur: TcmsAkteurAngaben;
  /** Mandant der Aktion nach Zugriffsprüfung (kanzleiAkteurTx) oder null. */
  mandantId: string | null;
}

export interface TcmsKanzleiAktionSpec<TData, V, TRun> extends TcmsAktionsAbbildung {
  /**
   * Mandant der Aktion – als gebundenes Argument der Server Action
   * (`aktion.bind(null, mandantId)`), nie ungeprüft aus dem Formular. Der
   * Zugriff wird über die Akteursbestätigung geprüft (kein Zugriff: keine
   * Bestätigung, kein Aufruf). `null`: kanzleiweite Aktion ohne Mandant.
   */
  mandantId: string | null;
  /** Nur Admin/Partner (kanzleiweite Verwaltung, z. B. Audit-Prüfung). */
  nurAdmin?: boolean;
  /** Eingabeprüfung nach dem Gate (parseFormData/parseActionInput). */
  parse?: () => ActionParseResult<TData>;
  /** In der Tenant-Transaktion nach dem Akteur: Daten der kanzleikonsole laden und prüfen. */
  vorbereiten?: (tx: TxClient, k: TcmsKanzleiKontext, data: TData) => Promise<V>;
  /** Außerhalb jeder Transaktion: der Dienstaufruf; Rückgabe = Nutzlast des Ergebnisses. */
  aufruf: (dienst: TcmsDienst, data: TData, vorbereitet: V) => Promise<TRun>;
}

/** Revalidiert den TCMS-Bereich eines Mandanten und das Portfolio. */
export function revalidiereTcmsMandant(mandantId: string): void {
  revalidatePath(`/staff/clients/${encodeURIComponent(mandantId)}/tcms`, 'layout');
  revalidatePath('/staff/tcms', 'layout');
}

/** Schreibende Kanzlei-Aktion gegen das TCMS (Ablauf im Kopf dieser Datei). */
export function tcmsKanzleiAktion<
  TData = undefined,
  V = undefined,
  TRun extends ActionRunResult = void,
>(spec: TcmsKanzleiAktionSpec<TData, V, TRun>): Promise<ActionOutcome<TRun>> {
  const zuletzt = { name: null as string | null };
  return staffAction<TRun, TData>({
    guard: { module: 'tcms', ...(spec.nurAdmin ? { requireAdmin: true } : {}) },
    ...(spec.parse ? { parse: spec.parse } : {}),
    run: async (g, data) => {
      const { akteur, vorbereitet } = await withTenantContext(g.ctx, async (tx) => {
        await assertTcmsAktivTx(tx, g.tenantId);
        const akteur = await kanzleiAkteurTx(
          tx,
          g.session,
          spec.mandantId === null ? {} : { mandantId: spec.mandantId },
        );
        const kontext: TcmsKanzleiKontext = { g, akteur, mandantId: spec.mandantId };
        const vorbereitet = spec.vorbereiten
          ? await spec.vorbereiten(tx, kontext, data)
          : (undefined as V);
        return { akteur, vorbereitet };
      });
      const ergebnis = await spec.aufruf(
        dienstFuer({ akteur, mandantId: spec.mandantId, portal: false, zuletzt }),
        data,
        vorbereitet,
      );
      if (!istFehlschlag(ergebnis)) {
        if (spec.mandantId === null) revalidatePath('/staff/tcms', 'layout');
        else revalidiereTcmsMandant(spec.mandantId);
      }
      return ergebnis;
    },
    onError: (fehler) => abbilden(fehler, spec, zuletzt.name),
  });
}

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

export interface TcmsPortalKontext {
  g: PortalCtx;
  akteur: TcmsAkteurAngaben;
  /** Mandant der Portal-Sitzung (einzige Quelle). */
  mandantId: string;
}

export interface TcmsPortalAktionSpec<TData, V, TRun> extends TcmsAktionsAbbildung {
  parse?: () => ActionParseResult<TData>;
  vorbereiten?: (tx: TxClient, k: TcmsPortalKontext, data: TData) => Promise<V>;
  aufruf: (dienst: TcmsDienst, data: TData, vorbereitet: V) => Promise<TRun>;
}

/** Schreibende Portal-Aktion gegen das TCMS; nur Portal-Endpunkte des eigenen Mandanten. */
export function tcmsPortalAktion<
  TData = undefined,
  V = undefined,
  TRun extends ActionRunResult = void,
>(spec: TcmsPortalAktionSpec<TData, V, TRun>): Promise<ActionOutcome<TRun>> {
  const zuletzt = { name: null as string | null };
  return portalAction<TRun, TData>({
    guard: { module: 'tcms' },
    ...(spec.parse ? { parse: spec.parse } : {}),
    run: async (g, data) => {
      const { akteur, vorbereitet } = await withTenantContext(g.ctx, async (tx) => {
        await assertTcmsAktivTx(tx, g.tenantId);
        const akteur = await portalAkteurTx(tx, g.session);
        const kontext: TcmsPortalKontext = { g, akteur, mandantId: g.clientId };
        const vorbereitet = spec.vorbereiten
          ? await spec.vorbereiten(tx, kontext, data)
          : (undefined as V);
        return { akteur, vorbereitet };
      });
      const ergebnis = await spec.aufruf(
        dienstFuer({ akteur, mandantId: g.clientId, portal: true, zuletzt }),
        data,
        vorbereitet,
      );
      if (!istFehlschlag(ergebnis)) revalidatePath('/portal/tcms', 'layout');
      return ergebnis;
    },
    onError: (fehler) => abbilden(fehler, spec, zuletzt.name),
  });
}
