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
import type { KonfliktGrund, VerweigerungGrund } from '@taxtronik/tcms-contract';
import type { ActionFailure } from '@/server/actions/action-runner';
import { log } from '@/server/logger';
import { TcmsAkteurVerweigert } from './akteur';
import { TcmsInaktivError } from './dienst';
import { TcmsPersonUnzulaessig } from './personen';
import { vertragsZeichenMeldung } from './zeichen';

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
 * Feste Meldungen je Verweigerungsgrund des Dienstes (`fehler.grund` jedes 403,
 * TCMS s5; VERWEIGERUNG_GRUENDE im Vertrag). Vollständig über alle Gründe
 * (`satisfies`): Ein neuer Grund im Vertrag bricht die Typprüfung, bis er hier
 * einen festen Text hat. Der Text des Dienstes wird nie durchgereicht.
 */
const KEIN_RECHT_JE_GRUND = {
  /** Bearbeiten im Mandanten (kannBearbeiten im Dienst). */
  BEARBEITEN:
    'Dieser Schritt ist Admins und Partnern sowie der zuständigen Berufsträgerin oder Hauptbearbeitung des Mandanten vorbehalten.',
  /**
   * Zuständige Berufsträger:in (kannWuerdigen im Dienst): §-153-Würdigung und
   * vertraulich markieren.
   */
  WUERDIGEN:
    'Dieser Schritt (§-153-Würdigung, vertraulich markieren) ist den zuständigen Berufsträgerinnen und Berufsträgern des Mandanten vorbehalten.',
  /**
   * Vier-Augen-Prinzip: dieselbe Person darf nicht beantragen bzw. mitwirken und
   * entscheiden (Übersteuerung, Risikofreigabe, Frequenzabweichung, Verwerfen,
   * Gegenzeichnung, Review; vorher je Bereich „ZWEITE_PERSON“).
   */
  VIER_AUGEN: 'Vier-Augen-Prinzip: Diesen Schritt muss eine andere Person ausführen.',
  /** Kanzleiweite Verwaltung (z. B. Audit). */
  VERWALTUNG: 'Dieser Schritt ist Admins und Partnern der Kanzlei vorbehalten.',
  /** Vertrauliche Feststellung: nur Beteiligte (kannVertraulichLesen im Dienst). */
  VERTRAULICH: 'Diese Feststellung ist vertraulich; nur Beteiligte können sie bearbeiten.',
  /** Durchführung einer Kontrolle (kannDurchfuehren im Dienst). */
  DURCHFUEHREN:
    'Dieser Schritt ist der zugewiesenen durchführenden Person oder ihrer Vertretung vorbehalten.',
  /** Gegenzeichnung bzw. Zurückweisung einer eingereichten Durchführung (kannGegenzeichnen). */
  GEGENZEICHNEN:
    'Die Gegenzeichnung ist der vorgesehenen gegenzeichnenden Person oder zuständigen Berufsträgerinnen und Berufsträgern vorbehalten, nie der durchführenden Person.',
  /** Schritt der anderen Seite (Kanzlei bzw. Mandant), z. B. eine Kontrolle des Mandanten. */
  PARTEI: 'Diesen Schritt führt die andere Seite aus (Kanzlei bzw. Mandant).',
  /** Portal: Rolle beim Mandanten fehlt (gesetzliche Vertretung, Tax-Compliance-Beauftragte). */
  PORTAL_ROLLE:
    'Dieser Schritt ist der gesetzlichen Vertretung oder den Tax-Compliance-Beauftragten Ihres Unternehmens vorbehalten.',
  /** Portal: Aufgabe oder Freigabe ist einer anderen Person zugeordnet. */
  PORTAL_ZUGEORDNET: 'Dieser Schritt ist der zugeordneten Person vorbehalten.',
} as const satisfies Readonly<Record<VerweigerungGrund, string>>;

/**
 * Rückfälle der Aktionen (`keinRecht`), wenn ein 403 keinen bekannten Grund
 * trägt (nur ohne Antwort des Dienstes denkbar; jede 403-Antwort hat einen).
 */
const KEIN_RECHT_RUECKFALL = {
  /** Fallback, wenn keiner der Schlüssel passt. */
  STANDARD: 'Dieser Schritt ist zuständigen Personen vorbehalten.',
  /** Verwerfen einer Feststellung bestätigen (kein eigener Grund im Dienst). */
  VERWERFEN_BESTAETIGEN:
    'Das Verwerfen bestätigt eine zweite Person; ist eine steuerliche Auswirkung nicht ausgeschlossen, nur die zuständige Berufsträgerin bzw. der zuständige Berufsträger.',
} as const;

/**
 * Feste Meldungen für 403: je Grund des Dienstes und die Rückfälle der
 * Aktionen. Neue Schlüssel nur hier ergänzen, nie umformulieren (Test:
 * zustand.test.ts).
 */
export const TCMS_KEIN_RECHT = { ...KEIN_RECHT_JE_GRUND, ...KEIN_RECHT_RUECKFALL } as const;

export type TcmsKeinRechtGrund = keyof typeof TCMS_KEIN_RECHT;

/**
 * Fester Text zu einer Verweigerung: der Grund des Dienstes zuerst, sonst der
 * Rückfall der Aktion (bzw. `STANDARD`). Unbekannte Werte fallen zurück.
 */
export function keinRechtText(
  verweigerung: VerweigerungGrund | null | undefined,
  rueckfall: TcmsKeinRechtGrund = 'STANDARD',
): string {
  if (typeof verweigerung === 'string' && Object.hasOwn(KEIN_RECHT_JE_GRUND, verweigerung)) {
    return KEIN_RECHT_JE_GRUND[verweigerung];
  }
  return TCMS_KEIN_RECHT[rueckfall];
}

export const TCMS_AKTION_TEXTE = {
  keinZugriff: 'Kein Zugriff auf das Tax-CMS.',
  neuAnmelden: `Kein Zugriff auf das Tax-CMS. ${TCMS_NEU_ANMELDEN}`,
  nichtAktiv: 'Das Tax-CMS ist für diese Kanzlei nicht aktiv.',
  konflikt: 'Wurde zwischenzeitlich geändert – bitte neu laden.',
  nichtGefunden: 'Der Eintrag wurde im Tax-CMS nicht gefunden. Bitte laden Sie die Seite neu.',
  ungueltig: 'Bitte prüfen Sie die markierten Angaben.',
  feld: 'Bitte prüfen Sie diese Angabe.',
  /** 400 ohne Feld, das die Seite markieren kann (TCMS s8). */
  ungueltigOhneFeld:
    'Die Angaben wurden nicht angenommen. Bitte prüfen Sie sie – etwa auf unsichtbare Sonderzeichen aus kopierten Texten – und versuchen Sie es erneut.',
  nichtErreichbar:
    'Das Tax-CMS ist derzeit nicht erreichbar. Bitte versuchen Sie es in einigen Minuten erneut.',
  /** Schreibender Aufruf ohne verlässliche Antwort: Ausgang unbekannt. */
  unklar:
    'Das Tax-CMS hat nicht rechtzeitig oder nicht lesbar geantwortet. Bitte laden Sie die Seite neu und prüfen Sie, ob die Änderung übernommen wurde.',
} as const;

/**
 * Feste Meldungen je Konfliktgrund des Dienstes (`fehler.konflikt` eines 409,
 * TCMS s10; KONFLIKT_GRUENDE im Vertrag). Vollständig über alle Gründe
 * (`satisfies`): Ein neuer Grund im Vertrag bricht die Typprüfung, bis er hier
 * einen festen Text hat. Die Gründe stehen heute nur an Portal-Endpunkten
 * (Code anfordern, Freigeben, Ereignis melden), deshalb in Sie-Form. Der Text
 * des Dienstes (`meldung`) wird nie durchgereicht. Neue Texte werden
 * ergänzt, nie umformuliert (Test: zustand.test.ts).
 */
const KONFLIKT_JE_GRUND = {
  /** Freigabe nicht mehr offen (erteilt, abgelehnt oder gegenstandslos). */
  BEREITS_ERLEDIGT:
    'Diese Anforderung ist bereits erledigt oder nicht mehr offen. Bitte laden Sie die Seite neu.',
  /** Fünf Fehlversuche; nur eine Neuadressierung durch die Kanzlei entsperrt. */
  CODE_GESPERRT:
    'Der Bestätigungscode ist nach mehreren Fehlversuchen gesperrt. Bitte wenden Sie sich an Ihre Kanzlei.',
  /** Mengenbegrenzung je Stunde; der zuletzt erhaltene Code gilt weiter. */
  ZU_VIELE_CODES:
    'Sie haben in der letzten Stunde bereits mehrere Codes angefordert. Bitte verwenden Sie den zuletzt gesendeten Code oder versuchen Sie es später erneut.',
  /** Freigeben ohne angeforderten Code (nie angefordert oder durch Neuadressierung geleert). */
  CODE_FEHLT: 'Bitte fordern Sie zuerst einen Bestätigungscode an.',
  /** Frist abgelaufen oder Code-Schlüssel im Tax-CMS gewechselt. */
  CODE_ABGELAUFEN: 'Der Code ist nicht mehr gültig. Bitte fordern Sie einen neuen an.',
  /** Beschreibung: Version liegt nicht (mehr) beim Mandanten. */
  VERSION_NICHT_VORGELEGT:
    'Diese Fassung liegt Ihnen nicht mehr zur Freigabe vor. Bitte laden Sie die Seite neu.',
  /** Beschreibung: eingefrorener Inhalt fehlt oder passt nicht; die Kanzlei fordert neu an. */
  INHALT_VERAENDERT:
    'Die vorgelegte Fassung kann nicht mehr freigegeben werden. Ihre Kanzlei legt sie Ihnen erneut vor.',
  /** Gleichzeitige Änderung (bedingtes Schreiben bzw. Schreibkonflikt im Dienst). */
  ZWISCHENZEITLICH_GEAENDERT: TCMS_AKTION_TEXTE.konflikt,
  /** Portal-Meldung: derselbe Idempotenzschlüssel mit anderem Inhalt (24 h). */
  IDEMPOTENZ_ABWEICHUNG:
    'Diese Meldung wurde bereits mit anderem Inhalt übermittelt. Bitte laden Sie die Seite neu und prüfen Sie Ihre bisherigen Meldungen.',
} as const satisfies Readonly<Record<KonfliktGrund, string>>;

/** Feste Meldungen je Konfliktgrund (siehe oben). */
export const TCMS_KONFLIKT_TEXTE: Readonly<Record<KonfliktGrund, string>> = KONFLIKT_JE_GRUND;

/**
 * Fester Text zu einem Konflikt (409): der Grund des Dienstes zuerst, sonst der
 * Rückfall der Aktion (Standard: „zwischenzeitlich geändert“). Unbekannte
 * Werte und Namen aus dem Objekt-Prototyp fallen zurück (Lookup per hasOwn).
 */
export function konfliktText(
  konflikt: KonfliktGrund | null | undefined,
  rueckfall: string = TCMS_AKTION_TEXTE.konflikt,
): string {
  if (typeof konflikt === 'string' && Object.hasOwn(KONFLIKT_JE_GRUND, konflikt)) {
    return KONFLIKT_JE_GRUND[konflikt];
  }
  return rueckfall;
}

export interface TcmsAktionsAbbildung {
  /**
   * Rückfall bei 403 ohne Grund des Dienstes (Standard `STANDARD`); mit Grund
   * (`verweigerung`, TCMS s5) gilt immer der Text zu diesem Grund.
   */
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
    ergebnis[feld] = [feldText(felder[pfad])];
  }
  return ergebnis;
}

/**
 * Text eines Feldfehlers: die feste Zeichenmeldung des Vertrags, wenn der
 * Feldfehler genau eine davon ist (TCMS s8: „Unzulässige Zeichen“, Basisregel
 * der Freitexte – gleich, ob die lokale Prüfung oder der Dienst sie meldet),
 * sonst der allgemeine Feldtext. Andere Texte des Dienstes erscheinen nie.
 */
function feldText(texte: readonly string[] | undefined): string {
  for (const text of Array.isArray(texte) ? texte : []) {
    const meldung = typeof text === 'string' ? vertragsZeichenMeldung(text) : null;
    if (meldung !== null) return meldung;
  }
  return TCMS_AKTION_TEXTE.feld;
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
    const mitFeld = Object.keys(fieldErrors).length > 0;
    return {
      ok: false,
      // Ohne zugeordnetes Feld (z. B. Textfehler der Datenbank des Dienstes,
      // TCMS s8) gibt es nichts zu markieren: eigener Text mit Hinweis.
      error: mitFeld ? TCMS_AKTION_TEXTE.ungueltig : TCMS_AKTION_TEXTE.ungueltigOhneFeld,
      errorCode: 'VALIDATION_ERROR',
      ...(mitFeld ? { fieldErrors } : {}),
    };
  }
  if (fehler instanceof TcmsKonflikt) {
    // TCMS s10: fester Text je Grund (`fehler.konflikt`), ohne Grund der Sammeltext.
    return { ok: false, error: konfliktText(fehler.konflikt), errorCode: 'CONFLICT' };
  }
  if (fehler instanceof TcmsNichtBerechtigt) {
    return {
      ok: false,
      error: keinRechtText(fehler.verweigerung, abbildung.keinRecht),
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
    // Grund eines 403 nur als Wert der festen Liste (nie der Text des Dienstes).
    ...(fehler instanceof TcmsNichtBerechtigt ? { verweigerung: fehler.verweigerung } : {}),
    // Grund eines 409 ebenso nur als Wert der festen Liste (TCMS s10).
    ...(fehler instanceof TcmsKonflikt ? { konflikt: fehler.konflikt } : {}),
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
