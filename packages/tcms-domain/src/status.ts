// =============================================================================
// Statusmodelle (Fachkonzept Abschnitt 9). „Fällig" und „Überfällig" werden
// aus Datum und gespeichertem Status abgeleitet, nicht gespeichert — dadurch
// stimmen sie auch für jeden Stichtag.
// =============================================================================

import type { BetriebsStand } from './bewertung';
import { nachTag } from './kalender';

/** Gespeicherter Status einer Kontrolldurchführung. */
export type DurchfuehrungStatus =
  | 'GEPLANT'
  | 'IN_DURCHFUEHRUNG'
  | 'ZUR_GEGENZEICHNUNG'
  | 'ZURUECKGEWIESEN'
  | 'OHNE_BEFUND'
  | 'MIT_BEFUND'
  | 'ENTFALLEN';

/** Angezeigter Status (inkl. abgeleiteter Zustände). */
export type AnzeigeStatus =
  | 'GEPLANT'
  | 'FAELLIG'
  | 'IN_DURCHFUEHRUNG'
  | 'ZUR_GEGENZEICHNUNG'
  | 'ZURUECKGEWIESEN'
  | 'OHNE_BEFUND'
  | 'MIT_BEFUND'
  | 'UEBERFAELLIG'
  | 'ENTFALLEN';

export const ANZEIGE_LABEL: Record<AnzeigeStatus, string> = {
  GEPLANT: 'Geplant',
  FAELLIG: 'Fällig',
  IN_DURCHFUEHRUNG: 'In Durchführung',
  ZUR_GEGENZEICHNUNG: 'Zur Gegenzeichnung',
  ZURUECKGEWIESEN: 'Zurückgewiesen',
  OHNE_BEFUND: 'abgeschlossen – ohne Befund',
  MIT_BEFUND: 'abgeschlossen – mit Befund',
  UEBERFAELLIG: 'Überfällig',
  ENTFALLEN: 'Entfallen',
};

export const ANZEIGE_BADGE: Record<AnzeigeStatus, string> = {
  GEPLANT: 'badge-gray',
  FAELLIG: 'badge-brand',
  IN_DURCHFUEHRUNG: 'badge-brand',
  ZUR_GEGENZEICHNUNG: 'badge-purple',
  ZURUECKGEWIESEN: 'badge-yellow',
  OHNE_BEFUND: 'badge-green',
  MIT_BEFUND: 'badge-yellow',
  UEBERFAELLIG: 'badge-red',
  ENTFALLEN: 'badge-gray',
};

export interface DurchfuehrungZeit {
  status: DurchfuehrungStatus;
  periodeBis: Date;
  faelligAm: Date;
  begonnenAm?: Date | null;
  /** Letzte Einreichung (eine erneute Einreichung überschreibt sie). */
  eingereichtAm?: Date | null;
  /**
   * Letzte Zurückweisung; bleibt nach erneuter Einreichung stehen. `null` bei
   * Durchführungen ohne Zurückweisung und bei Zurückweisungen, die vor der
   * Spalte entstanden sind (dann gilt die Zurückweisung ab `eingereichtAm`).
   */
  zurueckgewiesenAm: Date | null;
  abgeschlossenAm?: Date | null;
  entfallenAm?: Date | null;
}

const OFFEN: readonly DurchfuehrungStatus[] = ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];

/**
 * Status, wie er zum Stichtag `stand` galt. Für den aktuellen Stand ist
 * `stand` = heute. Zustände gelten ab dem Kalendertag (Europe/Berlin) ihres
 * Zeitstempels (`kalendertagVon`).
 *
 * Grenze: Gespeichert sind nur die letzte Einreichung und die letzte
 * Zurückweisung. Für Stichtage vor der letzten Zurückweisung einer erneut
 * eingereichten Durchführung (frühere Prüfrunden) gilt der Stand vor der
 * Einreichung (in Durchführung bzw. überfällig).
 */
export function statusAm(d: DurchfuehrungZeit, stand: Date): AnzeigeStatus {
  const vor = (x: Date | null | undefined) => x != null && !nachTag(x, stand);
  if ((d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND') && vor(d.abgeschlossenAm)) {
    return d.status;
  }
  if (d.status === 'ENTFALLEN' && vor(d.entfallenAm)) return 'ENTFALLEN';
  const zurueckgewiesen = () => (nachTag(stand, d.faelligAm) ? 'UEBERFAELLIG' : 'ZURUECKGEWIESEN');
  if (d.status === 'ZURUECKGEWIESEN') {
    // Zurückgewiesen ab der Zurückweisung, davor (ab der Einreichung) zur Gegenzeichnung.
    if (vor(d.zurueckgewiesenAm ?? d.eingereichtAm)) return zurueckgewiesen();
    if (vor(d.eingereichtAm)) return 'ZUR_GEGENZEICHNUNG';
  }
  const eingereicht =
    d.status === 'ZUR_GEGENZEICHNUNG' || d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND';
  if (eingereicht && vor(d.eingereichtAm)) return 'ZUR_GEGENZEICHNUNG';
  // Erneut eingereicht: zwischen Zurückweisung und erneuter Einreichung zurückgewiesen.
  if (eingereicht && vor(d.zurueckgewiesenAm)) return zurueckgewiesen();
  if (nachTag(stand, d.faelligAm)) return 'UEBERFAELLIG';
  const begonnen = vor(d.begonnenAm) && d.status !== 'GEPLANT';
  if (begonnen) return 'IN_DURCHFUEHRUNG';
  return nachTag(d.periodeBis, stand) ? 'GEPLANT' : 'FAELLIG';
}

export function istOffen(s: AnzeigeStatus): boolean {
  return (
    s === 'FAELLIG' || s === 'IN_DURCHFUEHRUNG' || s === 'ZURUECKGEWIESEN' || s === 'UEBERFAELLIG'
  );
}

export function istAbgeschlossen(s: AnzeigeStatus): boolean {
  return s === 'OHNE_BEFUND' || s === 'MIT_BEFUND';
}

/** Durchführung mit den Feldern, die ihre Reihenfolge im Betriebsstand festlegen. */
export interface DurchfuehrungImBetrieb extends DurchfuehrungZeit {
  id: string;
  periodeVon: Date;
  /** Durchführung, die dieser Nachtrag korrigiert (AGENTS.md Regel 3), sonst `null`. */
  nachtragZuId: string | null;
  /** Zeitpunkt der Anlage. */
  angelegtAm: Date;
}

/**
 * Betriebsstand einer Kontrolle für Netto (Betrieb): maßgeblich ist die
 * jüngste Durchführung, die entweder abgeschlossen oder überfällig ist.
 * Eingereichte, noch nicht fällige Durchführungen werden übersprungen.
 * „Jüngste" = späteste Periode; in derselben Periode geht ein Nachtrag seinem
 * Original vor (Korrektur, AGENTS.md Regel 3; auch Nachträge zu Nachträgen),
 * danach die zuletzt angelegte, zuletzt die ID – das Ergebnis hängt nie von der
 * Reihenfolge der Eingabe ab.
 */
export function betriebsStand(
  durchfuehrungen: readonly DurchfuehrungImBetrieb[],
  stand: Date,
): BetriebsStand {
  const jeId = new Map(durchfuehrungen.map((d) => [d.id, d]));
  /** Zahl der Nachtragsstufen bis zum Original (begrenzt, falls Daten einen Kreis bilden). */
  const stufe = (d: DurchfuehrungImBetrieb): number => {
    let n = 0;
    for (let x = d; x.nachtragZuId && n < jeId.size; n++) {
      const original = jeId.get(x.nachtragZuId);
      if (!original) return n + 1;
      x = original;
    }
    return n;
  };
  const relevante = durchfuehrungen
    .map((d) => ({ d, s: statusAm(d, stand), stufe: stufe(d) }))
    .filter(({ s }) => s === 'OHNE_BEFUND' || s === 'MIT_BEFUND' || s === 'UEBERFAELLIG')
    .sort(
      (a, b) =>
        b.d.periodeVon.getTime() - a.d.periodeVon.getTime() ||
        b.stufe - a.stufe ||
        b.d.angelegtAm.getTime() - a.d.angelegtAm.getTime() ||
        (a.d.id < b.d.id ? 1 : a.d.id > b.d.id ? -1 : 0),
    );
  const letzte = relevante[0];
  if (!letzte) return 'KEINE';
  if (letzte.s === 'OHNE_BEFUND') return 'OK';
  if (letzte.s === 'MIT_BEFUND') return 'MIT_BEFUND';
  return 'UEBERFAELLIG';
}

export { OFFEN as OFFENE_GESPEICHERTE_STATUS };

// ----------------------------------------------------------------------------
// Feststellung
// ----------------------------------------------------------------------------

export type FeststellungStatus =
  | 'ERFASST'
  | 'IN_WUERDIGUNG'
  | 'MASSNAHMEN_OFFEN'
  | 'NACHKONTROLLE'
  | 'GESCHLOSSEN'
  | 'VERWORFEN';

export const FESTSTELLUNG_STATUS_LABEL: Record<FeststellungStatus, string> = {
  ERFASST: 'Erfasst',
  IN_WUERDIGUNG: 'In Würdigung',
  MASSNAHMEN_OFFEN: 'Maßnahmen offen',
  NACHKONTROLLE: 'Nachkontrolle',
  GESCHLOSSEN: 'Geschlossen',
  VERWORFEN: 'Verworfen',
};

export const FESTSTELLUNG_SCHRITTE: readonly FeststellungStatus[] = [
  'ERFASST',
  'IN_WUERDIGUNG',
  'MASSNAHMEN_OFFEN',
  'NACHKONTROLLE',
  'GESCHLOSSEN',
];

export type FeststellungQuelle =
  | 'KONTROLLE'
  | 'EREIGNIS'
  | 'STICHPROBE'
  | 'HINWEIS'
  | 'AUSSENPRUEFUNG';
export const QUELLE_LABEL: Record<FeststellungQuelle, string> = {
  KONTROLLE: 'Kontrolle',
  EREIGNIS: 'Ereignis',
  STICHPROBE: 'Stichprobe',
  HINWEIS: 'Hinweis',
  AUSSENPRUEFUNG: 'Außenprüfung',
};

export type FeststellungKlasse =
  | 'DESIGNMANGEL'
  | 'DURCHFUEHRUNGSMANGEL'
  | 'STEUERLICHER_FEHLER'
  | 'HINWEIS';
export const FESTSTELLUNG_KLASSE_LABEL: Record<FeststellungKlasse, string> = {
  DESIGNMANGEL: 'Designmangel',
  DURCHFUEHRUNGSMANGEL: 'Durchführungsmangel',
  STEUERLICHER_FEHLER: 'steuerlicher Fehler',
  HINWEIS: 'Hinweis',
};

export type Auswirkung = 'JA' | 'NEIN' | 'UNKLAR';
export const AUSWIRKUNG_LABEL: Record<Auswirkung, string> = {
  JA: 'ja',
  NEIN: 'nein',
  UNKLAR: 'unklar',
};
export const AUSWIRKUNG_BADGE: Record<Auswirkung, string> = {
  JA: 'badge-red',
  NEIN: 'badge-gray',
  UNKLAR: 'badge-yellow',
};

/** Vier gleichrangige §-153-Optionen ohne Vorauswahl. */
export type Paragraph153Entscheidung =
  | 'BERICHTIGUNG'
  | 'KEINE_PFLICHT'
  | 'WEITERE_KLAERUNG'
  | 'UEBERGABE';
export const P153_LABEL: Record<Paragraph153Entscheidung, string> = {
  BERICHTIGUNG: 'Berichtigung erforderlich',
  KEINE_PFLICHT: 'Keine Berichtigungspflicht',
  WEITERE_KLAERUNG: 'Weitere Klärung bis …',
  UEBERGABE: 'Übergabe an spezialisierte Beratung',
};

export function p153Erforderlich(a: Auswirkung): boolean {
  return a === 'JA' || a === 'UNKLAR';
}

/** Eine Entscheidung „weitere Klärung" ist nicht abschließend und erlaubt eine Folgeentscheidung. */
export function p153Abschliessend(e: string | null | undefined): boolean {
  return e != null && e !== 'WEITERE_KLAERUNG';
}

/**
 * §-153-Würdigung offen zum Stichtag `ende`: Steuerwirkung nicht
 * ausgeschlossen, nicht verworfen und bis zum Stichtag keine abschließende
 * Entscheidung („weitere Klärung" lässt sie offen). Eine abschließende
 * Entscheidung ist endgültig; liegt sie nach dem Stichtag, war die Würdigung
 * zum Stichtag offen. Einzige Regel für Listen, Kontext, Länder-Monitor und
 * Arbeitskorb (wie `naechsterFeststellungsschritt`).
 */
export function p153Offen(
  f: {
    auswirkung: Auswirkung;
    status: FeststellungStatus;
    p153Entscheidung: string | null;
    p153EntschiedenAm: Date | null;
  },
  ende: Date,
): boolean {
  if (!p153Erforderlich(f.auswirkung) || f.status === 'VERWORFEN') return false;
  const abschliessend =
    p153Abschliessend(f.p153Entscheidung) &&
    f.p153EntschiedenAm != null &&
    f.p153EntschiedenAm.getTime() <= ende.getTime();
  return !abschliessend;
}

export interface FeststellungFakten {
  status: FeststellungStatus;
  auswirkung: Auswirkung;
  p153Entschieden: boolean;
  massnahmen: number;
  massnahmenOffen: number;
  nachkontrolleOhneBefund: boolean;
}

/** Nächster zulässiger Status und, falls blockiert, der Grund. */
export function naechsterFeststellungsschritt(f: FeststellungFakten): {
  ziel: FeststellungStatus | null;
  blockiert: string | null;
} {
  switch (f.status) {
    case 'ERFASST':
      return { ziel: 'IN_WUERDIGUNG', blockiert: null };
    case 'IN_WUERDIGUNG':
      if (p153Erforderlich(f.auswirkung) && !f.p153Entschieden) {
        return {
          ziel: 'MASSNAHMEN_OFFEN',
          blockiert: '§-153-Würdigung durch Berufsträger steht aus',
        };
      }
      if (f.massnahmen === 0)
        return { ziel: 'MASSNAHMEN_OFFEN', blockiert: 'mindestens eine Maßnahme anlegen' };
      return { ziel: 'MASSNAHMEN_OFFEN', blockiert: null };
    case 'MASSNAHMEN_OFFEN':
      if (f.massnahmenOffen > 0)
        return { ziel: 'NACHKONTROLLE', blockiert: 'offene Maßnahmen erledigen' };
      return { ziel: 'NACHKONTROLLE', blockiert: null };
    case 'NACHKONTROLLE':
      if (!f.nachkontrolleOhneBefund) {
        return {
          ziel: 'GESCHLOSSEN',
          blockiert: 'Nachkontrolle ohne Befund und gegengezeichnet fehlt',
        };
      }
      return { ziel: 'GESCHLOSSEN', blockiert: null };
    default:
      return { ziel: null, blockiert: null };
  }
}

// ----------------------------------------------------------------------------
// Ereignis
// ----------------------------------------------------------------------------

export type EreignisStatus = 'NEU' | 'IN_TRIAGE' | 'ERLEDIGT' | 'VERWORFEN';
export const EREIGNIS_STATUS_LABEL: Record<EreignisStatus, string> = {
  NEU: 'neu',
  IN_TRIAGE: 'in Triage',
  ERLEDIGT: 'erledigt',
  VERWORFEN: 'verworfen',
};
export const EREIGNIS_STATUS_BADGE: Record<EreignisStatus, string> = {
  NEU: 'badge-brand',
  IN_TRIAGE: 'badge-yellow',
  ERLEDIGT: 'badge-green',
  VERWORFEN: 'badge-gray',
};

export type EreignisQuelle = 'PORTAL' | 'KONTROLLE' | 'STAMMDATEN' | 'RSS' | 'MANUELL';
export const EREIGNIS_QUELLE_LABEL: Record<EreignisQuelle, string> = {
  PORTAL: 'Portal',
  KONTROLLE: 'Kontrolle',
  STAMMDATEN: 'Stammdaten',
  RSS: 'RSS',
  MANUELL: 'manuell',
};

export type FolgeStatus = 'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT' | 'VERWORFEN';

/** Ein Ereignis ist erst erledigt, wenn jede Folge erledigt oder verworfen ist. */
export function ereignisErledigt(folgen: readonly { status: FolgeStatus }[]): boolean {
  return (
    folgen.length > 0 && folgen.every((f) => f.status === 'ERLEDIGT' || f.status === 'VERWORFEN')
  );
}
