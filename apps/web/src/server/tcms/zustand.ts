// =============================================================================
// Abbildung von TCMS-Fehlern auf Seiten- und Aktionszustände (TCMS Stufe 3).
//
// Eine Stelle für die Übersetzung „Dienst sagt X → Oberfläche zeigt Y“. Seiten
// (server/tcms/seite.ts) und Aktionen (server/tcms/aktion.ts) nutzen sie; die
// Bereiche schreiben keine eigenen Fehlerzweige.
//
// Sicherheitsregeln (docs/development/tcms-oberflaechen.md, Abschnitt 5):
// - Texte des Dienstes (`meldung`, `grund`, `felder`-Meldungen) erreichen die
//   Oberfläche nie. Angezeigt werden nur feste Texte aus den Tabellen unten;
//   der Grund einer Verweigerung (TcmsAkteurVerweigert.grund, ein Enum der
//   kanzleikonsole) wählt höchstens einen festen Hinweis.
// - Logs enthalten nur Fehlerklasse, HTTP-Status, Fehlercode, Endpunktname,
//   Ausfall-/Protokollgrund und die requestId des Dienstes – keine Antwort-
//   körper, Meldungen, Feldwerte oder Personenangaben (§ 203 StGB).
// - Fehler, die nicht aus dem TCMS stammen, werden nicht verschluckt: Die
//   Klassifikation liefert `null`, der Aufrufer wirft sie weiter (Fehlergrenze
//   bzw. zentrales Fehler-Mapping der Actions).
// =============================================================================

import {
  TcmsFehler,
  TcmsKonflikt,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
} from '@taxtronik/tcms-client';
import type { ActionFailure } from '@/server/actions/action-runner';
import { log } from '@/server/logger';
import { TcmsAkteurVerweigert } from './akteur';
import { TcmsInaktivError } from './dienst';
import { TcmsPersonUnzulaessig } from './personen';

// ---------------------------------------------------------------------------
// Seiten
// ---------------------------------------------------------------------------

/** Zustand einer TCMS-Seite, die keine Daten zeigen kann. */
export type TcmsSeitenZustand =
  /** Modul an, aber TCMS_DEPLOYMENT=disabled (oder Schalter zwischenzeitlich aus). */
  | { art: 'NICHT_KONFIGURIERT' }
  /** Keine Bestätigung (kanzleikonsole) oder 403 des Dienstes. */
  | { art: 'KEIN_ZUGRIFF'; neuAnmelden: boolean }
  /** Dienst nicht erreichbar, gestört oder Vertragsbruch (Transport, 5xx, 401, Schema). */
  | { art: 'NICHT_ERREICHBAR'; requestId: string | null }
  /** 400/409 auf einem Lesepfad: Anfrage der Seite passt nicht (z. B. Stichtag). */
  | { art: 'ANFRAGE_UNGUELTIG'; requestId: string | null };

export type TcmsSeitenZustandArt = TcmsSeitenZustand['art'];

/** Feste Texte je Zustand (Titel und Erklärung); Ausgabe: components/tcms/zustand.tsx. */
export const TCMS_SEITEN_TEXTE: Readonly<
  Record<TcmsSeitenZustandArt, { titel: string; text: string }>
> = {
  NICHT_KONFIGURIERT: {
    titel: 'Tax-CMS nicht eingerichtet',
    text: 'Das Tax-CMS ist für diese Installation noch nicht angebunden. Bitte wenden Sie sich an die Administration Ihrer Kanzlei.',
  },
  KEIN_ZUGRIFF: {
    titel: 'Kein Zugriff',
    text: 'Sie haben keinen Zugriff auf diesen Bereich des Tax-CMS.',
  },
  NICHT_ERREICHBAR: {
    titel: 'Tax-CMS derzeit nicht erreichbar',
    text: 'Die Daten des Tax-CMS können gerade nicht geladen werden. Bitte versuchen Sie es in einigen Minuten erneut.',
  },
  ANFRAGE_UNGUELTIG: {
    titel: 'Anfrage nicht möglich',
    text: 'Die Ansicht konnte mit diesen Angaben nicht geladen werden. Bitte öffnen Sie sie erneut über die Navigation.',
  },
};

/** Zusatzhinweis bei veralteter oder abgelaufener Sitzung (feste Tabelle, kein Rohgrund). */
export const TCMS_NEU_ANMELDEN =
  'Bitte melden Sie sich erneut an, damit Ihre aktuellen Rechte gelten.';

const NEU_ANMELDEN_GRUENDE: ReadonlySet<TcmsAkteurVerweigert['grund']> = new Set([
  'SITZUNG_ABGELAUFEN',
  'SITZUNG_VERALTET',
]);

/** requestId nur im Format des Clients (dort schon geprüft); sonst nicht anzeigen. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdVon(fehler: TcmsFehler): string | null {
  return fehler.requestId !== null && REQUEST_ID.test(fehler.requestId) ? fehler.requestId : null;
}

/**
 * Seitenzustand zu einem Fehler. `'NICHT_GEFUNDEN'`: 404 des Dienstes (die
 * Seite ruft notFound() bzw. behandelt ihn selbst); `null`: kein TCMS-Fehler,
 * der Aufrufer wirft weiter.
 */
export function seitenZustandAus(fehler: unknown): TcmsSeitenZustand | 'NICHT_GEFUNDEN' | null {
  if (fehler instanceof TcmsInaktivError) return { art: 'NICHT_KONFIGURIERT' };
  if (fehler instanceof TcmsAkteurVerweigert) {
    return { art: 'KEIN_ZUGRIFF', neuAnmelden: NEU_ANMELDEN_GRUENDE.has(fehler.grund) };
  }
  if (!(fehler instanceof TcmsFehler)) return null;
  if (fehler instanceof TcmsNichtGefunden) return 'NICHT_GEFUNDEN';
  if (fehler instanceof TcmsNichtBerechtigt) return { art: 'KEIN_ZUGRIFF', neuAnmelden: false };
  if (fehler instanceof TcmsUngueltig || fehler instanceof TcmsKonflikt) {
    return { art: 'ANFRAGE_UNGUELTIG', requestId: requestIdVon(fehler) };
  }
  // TcmsNichtVerfuegbar, TcmsProtokollFehler, TcmsNichtAuthentifiziert und
  // jede künftige Unterklasse: für Nutzer „nicht erreichbar“ (fail closed).
  return { art: 'NICHT_ERREICHBAR', requestId: requestIdVon(fehler) };
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

/**
 * Feste Meldungen für 403 des Dienstes. Die Aktion wählt den Schlüssel, der
 * zu ihrem fachlichen Schritt passt; der Text des Dienstes wird nie
 * durchgereicht. Neue Schlüssel nur hier ergänzen (Test: zustand.test.ts).
 */
export const TCMS_KEIN_RECHT = {
  /** Bearbeiten im Mandanten (kannBearbeiten im Dienst). */
  BEARBEITEN:
    'Dieser Schritt ist Admins und Partnern sowie der zuständigen Berufsträgerin oder Hauptbearbeitung des Mandanten vorbehalten.',
  /** §-153-Würdigung (kannWuerdigen im Dienst). */
  WUERDIGEN: 'Die §-153-Würdigung ist zuständigen Berufsträgerinnen und Berufsträgern vorbehalten.',
  /** Vier-Augen-Prinzip: dieselbe Person darf nicht beantragen und entscheiden. */
  VIER_AUGEN: 'Vier-Augen-Prinzip: Diesen Schritt muss eine andere Person ausführen.',
  /** Kanzleiweite Verwaltung (z. B. Audit). */
  VERWALTUNG: 'Dieser Schritt ist Admins und Partnern der Kanzlei vorbehalten.',
  /** Portal: Rolle beim Mandanten fehlt (gesetzliche Vertretung, Tax-Compliance-Beauftragte). */
  PORTAL_ROLLE:
    'Dieser Schritt ist der gesetzlichen Vertretung oder den Tax-Compliance-Beauftragten Ihres Unternehmens vorbehalten.',
  /** Portal: Aufgabe oder Freigabe ist einer anderen Person zugeordnet. */
  PORTAL_ZUGEORDNET: 'Dieser Schritt ist der zugeordneten Person vorbehalten.',
  /** Fallback, wenn keiner der Schlüssel passt. */
  STANDARD: 'Dieser Schritt ist zuständigen Personen vorbehalten.',
} as const;

export type TcmsKeinRechtGrund = keyof typeof TCMS_KEIN_RECHT;

export const TCMS_AKTION_TEXTE = {
  keinZugriff: 'Kein Zugriff auf das Tax-CMS.',
  neuAnmelden: `Kein Zugriff auf das Tax-CMS. ${TCMS_NEU_ANMELDEN}`,
  nichtAktiv: 'Das Tax-CMS ist für diese Kanzlei nicht aktiv.',
  konflikt: 'Wurde zwischenzeitlich geändert – bitte neu laden.',
  nichtGefunden: 'Der Eintrag wurde im Tax-CMS nicht gefunden. Bitte laden Sie die Seite neu.',
  ungueltig: 'Bitte prüfen Sie die markierten Angaben.',
  feld: 'Bitte prüfen Sie diese Angabe.',
  nichtErreichbar:
    'Das Tax-CMS ist derzeit nicht erreichbar. Bitte versuchen Sie es in einigen Minuten erneut.',
  /** Schreibender Aufruf ohne verlässliche Antwort: Ausgang unbekannt. */
  unklar:
    'Das Tax-CMS hat nicht rechtzeitig oder nicht lesbar geantwortet. Bitte laden Sie die Seite neu und prüfen Sie, ob die Änderung übernommen wurde.',
} as const;

export interface TcmsAktionsAbbildung {
  /** Fester Text bei 403 (Standard `STANDARD`). */
  keinRecht?: TcmsKeinRechtGrund;
  /**
   * Feldpfad des Dienstes (erstes Segment, ohne `body.`/`query.`) → Feldname
   * im Formular. Ohne Zuordnung landen Feldfehler unter dem gleichnamigen
   * Feld; mit Zuordnung nur die zugeordneten (übrige: nur die Sammelmeldung).
   */
  felder?: Readonly<Record<string, string>>;
}

const FELD_PFAD = /^[A-Za-z0-9_.[\]-]{1,120}$/;
const MAX_FELDER = 20;

function feldFehler(
  felder: Readonly<Record<string, readonly string[]>>,
  zuordnung: Readonly<Record<string, string>> | undefined,
): Record<string, string[]> {
  const ergebnis: Record<string, string[]> = {};
  for (const pfad of Object.keys(felder).slice(0, MAX_FELDER)) {
    if (!FELD_PFAD.test(pfad)) continue;
    const ohnePraefix = pfad.replace(/^(?:body|query|params)\./, '');
    const segment = ohnePraefix.split(/[.[]/)[0] ?? '';
    if (segment === '' || segment === '__proto__' || segment === 'constructor') continue;
    const feld =
      zuordnung === undefined
        ? segment
        : Object.hasOwn(zuordnung, segment)
          ? zuordnung[segment]
          : undefined;
    if (!feld) continue;
    ergebnis[feld] = [TCMS_AKTION_TEXTE.feld];
  }
  return ergebnis;
}

/**
 * Ergebnis einer Server-Aktion zu einem Fehler oder `undefined` (kein
 * TCMS-Fehler: zentrales Fehler-Mapping von staffAction/portalAction).
 * `schreibend`: Bei Zeitlimit, Transportabbruch oder unlesbarer Antwort ist
 * der Ausgang offen (keine Wiederholung bei POST/PUT, siehe tcms-client).
 */
export function aktionsFehlerAus(
  fehler: unknown,
  abbildung: TcmsAktionsAbbildung & { schreibend: boolean },
): ActionFailure | undefined {
  if (fehler instanceof TcmsInaktivError) {
    return { ok: false, error: TCMS_AKTION_TEXTE.nichtAktiv, errorCode: 'FORBIDDEN' };
  }
  if (fehler instanceof TcmsPersonUnzulaessig) {
    return {
      ok: false,
      error: fehler.message,
      errorCode: 'VALIDATION_ERROR',
      ...(fehler.feld ? { fieldErrors: { [fehler.feld]: [fehler.message] } } : {}),
    };
  }
  if (fehler instanceof TcmsAkteurVerweigert) {
    const neu = NEU_ANMELDEN_GRUENDE.has(fehler.grund);
    return {
      ok: false,
      error: neu ? TCMS_AKTION_TEXTE.neuAnmelden : TCMS_AKTION_TEXTE.keinZugriff,
      errorCode: neu ? 'UNAUTHORIZED' : 'FORBIDDEN',
    };
  }
  if (!(fehler instanceof TcmsFehler)) return undefined;
  if (fehler instanceof TcmsUngueltig) {
    const fieldErrors = feldFehler(fehler.felder, abbildung.felder);
    return {
      ok: false,
      error: TCMS_AKTION_TEXTE.ungueltig,
      errorCode: 'VALIDATION_ERROR',
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    };
  }
  if (fehler instanceof TcmsKonflikt) {
    return { ok: false, error: TCMS_AKTION_TEXTE.konflikt, errorCode: 'CONFLICT' };
  }
  if (fehler instanceof TcmsNichtBerechtigt) {
    return {
      ok: false,
      error: TCMS_KEIN_RECHT[abbildung.keinRecht ?? 'STANDARD'],
      errorCode: 'FORBIDDEN',
    };
  }
  if (fehler instanceof TcmsNichtGefunden) {
    return { ok: false, error: TCMS_AKTION_TEXTE.nichtGefunden, errorCode: 'NOT_FOUND' };
  }
  const ausgangOffen =
    abbildung.schreibend &&
    (fehler instanceof TcmsProtokollFehler ||
      (fehler instanceof TcmsNichtVerfuegbar &&
        (fehler.grund === 'ZEITLIMIT' || fehler.grund === 'TRANSPORT')));
  return {
    ok: false,
    error: ausgangOffen ? TCMS_AKTION_TEXTE.unklar : TCMS_AKTION_TEXTE.nichtErreichbar,
    errorCode: 'INTERNAL_ERROR',
  };
}

// ---------------------------------------------------------------------------
// Protokoll
// ---------------------------------------------------------------------------

/** Log-Felder eines TCMS-Fehlers: nur Klassifikation, nie Inhalte des Dienstes. */
export function tcmsLogFelder(fehler: unknown): Record<string, string | number | null> {
  if (fehler instanceof TcmsAkteurVerweigert) {
    return { fehler: fehler.name, grund: fehler.grund };
  }
  if (fehler instanceof TcmsInaktivError) return { fehler: fehler.name };
  if (!(fehler instanceof TcmsFehler)) return { fehler: 'unbekannt' };
  return {
    fehler: fehler.name,
    status: fehler.status,
    code: fehler.code,
    tcmsRequestId: requestIdVon(fehler),
    ...(fehler instanceof TcmsNichtVerfuegbar ? { grund: fehler.grund } : {}),
    ...(fehler instanceof TcmsProtokollFehler ? { grund: fehler.grund } : {}),
    ...(fehler instanceof TcmsUngueltig ? { lokal: fehler.lokal ? 1 : 0 } : {}),
  };
}

/**
 * Protokolliert einen TCMS-Fehler einer Seite oder Aktion. Erwartbares
 * (404, 403, 409, 400, Verweigerung) als `info`, Störungen als `warn`.
 */
export function protokolliereTcmsFehler(
  ort: { komponente: 'tcms-seite' | 'tcms-aktion'; endpunkt: string | null },
  fehler: unknown,
): void {
  const stoerung =
    fehler instanceof TcmsNichtVerfuegbar ||
    fehler instanceof TcmsProtokollFehler ||
    fehler instanceof TcmsNichtAuthentifiziert;
  const zeile = { component: ort.komponente, endpunkt: ort.endpunkt, ...tcmsLogFelder(fehler) };
  if (stoerung) log.warn(zeile, 'TCMS-Aufruf gestört');
  else log.info(zeile, 'TCMS-Aufruf abgewiesen');
}
