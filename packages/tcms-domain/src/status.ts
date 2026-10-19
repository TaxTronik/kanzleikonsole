// =============================================================================
// Statusmodelle (Fachkonzept Abschnitt 9). „Fällig" und „Überfällig" werden
// aus Datum und gespeichertem Status abgeleitet, nicht gespeichert — dadurch
// stimmen sie auch für jeden Stichtag.
// =============================================================================

import type { BetriebsStand } from './bewertung';

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
  eingereichtAm?: Date | null;
  abgeschlossenAm?: Date | null;
  entfallenAm?: Date | null;
}

const OFFEN: readonly DurchfuehrungStatus[] = ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];

function tag(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** true, wenn `a` (Tag) nach `b` (Tag) liegt. */
export function nachTag(a: Date, b: Date): boolean {
  return tag(a) > tag(b);
}

/**
 * Status, wie er zum Stichtag `stand` galt. Für den aktuellen Stand ist
 * `stand` = heute. Abgeschlossene Zustände gelten ab ihrem Zeitstempel.
 */
export function statusAm(d: DurchfuehrungZeit, stand: Date): AnzeigeStatus {
  const vor = (x: Date | null | undefined) => x != null && tag(x) <= tag(stand);
  if ((d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND') && vor(d.abgeschlossenAm)) {
    return d.status;
  }
  if (d.status === 'ENTFALLEN' && vor(d.entfallenAm)) return 'ENTFALLEN';
  const eingereicht =
    vor(d.eingereichtAm) &&
    (d.status === 'ZUR_GEGENZEICHNUNG' || d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND');
  if (eingereicht) return 'ZUR_GEGENZEICHNUNG';
  if (d.status === 'ZURUECKGEWIESEN' && vor(d.eingereichtAm)) {
    return nachTag(stand, d.faelligAm) ? 'UEBERFAELLIG' : 'ZURUECKGEWIESEN';
  }
  if (nachTag(stand, d.faelligAm)) return 'UEBERFAELLIG';
  const begonnen = vor(d.begonnenAm) && d.status !== 'GEPLANT';
  if (begonnen) return 'IN_DURCHFUEHRUNG';
  return tag(stand) >= tag(d.periodeBis) ? 'FAELLIG' : 'GEPLANT';
}

export function istOffen(s: AnzeigeStatus): boolean {
  return (
    s === 'FAELLIG' || s === 'IN_DURCHFUEHRUNG' || s === 'ZURUECKGEWIESEN' || s === 'UEBERFAELLIG'
  );
}

export function istAbgeschlossen(s: AnzeigeStatus): boolean {
  return s === 'OHNE_BEFUND' || s === 'MIT_BEFUND';
}

/** Tage zwischen zwei Daten (Kalendertage, b − a). */
export function tageZwischen(a: Date, b: Date): number {
  return Math.round((tag(b) - tag(a)) / 86_400_000);
}

/**
 * Betriebsstand einer Kontrolle für Netto (Betrieb): maßgeblich ist die
 * jüngste Durchführung, die entweder abgeschlossen oder überfällig ist.
 * Eingereichte, noch nicht fällige Durchführungen werden übersprungen.
 */
export function betriebsStand(
  durchfuehrungen: readonly (DurchfuehrungZeit & { periodeVon: Date })[],
  stand: Date,
): BetriebsStand {
  const relevante = durchfuehrungen
    .map((d) => ({ d, s: statusAm(d, stand) }))
    .filter(({ s }) => s === 'OHNE_BEFUND' || s === 'MIT_BEFUND' || s === 'UEBERFAELLIG')
    .sort((a, b) => b.d.periodeVon.getTime() - a.d.periodeVon.getTime());
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
