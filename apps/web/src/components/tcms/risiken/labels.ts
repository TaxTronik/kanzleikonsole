// =============================================================================
// Labels und reine Anzeigehelfer für Risikoinventar und Risikodetail (TCMS
// Stufe 3, portiert aus der Demo components/risiken/labels.ts). Ohne I/O.
// Stati und Klassen kommen aus der Antwort des Dienstes; hier stehen nur ihre
// Beschriftungen und die Anzeige-Vorschau der Mindestfrequenz aus
// @taxtronik/tcms-domain (Häufigkeitsmatrix, ungeprüfte Startwerte).
// =============================================================================

import type { RisikoEintrag } from '@taxtronik/tcms-contract';
import {
  frequenzLabel,
  KLASSE_LABEL,
  MATRIX_ZEILEN,
  matrixFrequenz,
  WAHRSCHEINLICHKEIT_LABEL,
  WAHRSCHEINLICHKEITEN,
  type GovernanceTyp,
  type Klasse,
  type Turnus,
  type Wahrscheinlichkeit,
} from '@taxtronik/tcms-domain';
import type { BadgeKlasse } from '../ton';

export type RisikoFreigabe = RisikoEintrag['freigabe'];
export type Sicht = 'DESIGN' | 'BETRIEB';
export type UebersteuerungStatus = RisikoEintrag['uebersteuerungen'][number]['status'];
export type AkzeptanzStatus = RisikoEintrag['akzeptanzen'][number]['status'];

export const RISIKO_FREIGABE_SCHRITTE: readonly RisikoFreigabe[] = [
  'IDENTIFIZIERT',
  'BEWERTET',
  'ZUR_FREIGABE',
  'FREIGEGEBEN',
];

export const RISIKO_FREIGABE_LABEL: Readonly<Record<RisikoFreigabe, string>> = {
  IDENTIFIZIERT: 'identifiziert',
  BEWERTET: 'bewertet',
  ZUR_FREIGABE: 'zur Freigabe',
  FREIGEGEBEN: 'freigegeben',
};

export const RISIKO_FREIGABE_BADGE: Readonly<Record<RisikoFreigabe, BadgeKlasse>> = {
  IDENTIFIZIERT: 'badge-yellow',
  BEWERTET: 'badge-brand',
  ZUR_FREIGABE: 'badge-purple',
  FREIGEGEBEN: 'badge-green',
};

export const SICHT_LABEL: Readonly<Record<Sicht, string>> = {
  DESIGN: 'Netto Design',
  BETRIEB: 'Netto Betrieb',
};

export const UEBERSTEUERUNG_STATUS_LABEL: Readonly<Record<UebersteuerungStatus, string>> = {
  BEANTRAGT: 'beantragt',
  FREIGEGEBEN: 'freigegeben',
  ABGELEHNT: 'abgelehnt',
  AUFGEHOBEN: 'aufgehoben',
};

export const UEBERSTEUERUNG_STATUS_BADGE: Readonly<Record<UebersteuerungStatus, BadgeKlasse>> = {
  BEANTRAGT: 'badge-purple',
  FREIGEGEBEN: 'badge-green',
  ABGELEHNT: 'badge-gray',
  AUFGEHOBEN: 'badge-gray',
};

export const AKZEPTANZ_STATUS_LABEL: Readonly<Record<AkzeptanzStatus, string>> = {
  OFFEN: 'Akzeptanz angefordert',
  FREIGEGEBEN: 'Risiko akzeptiert',
  ABGELEHNT: 'Akzeptanz abgelehnt',
};

export const AKZEPTANZ_STATUS_KURZ: Readonly<Record<AkzeptanzStatus, string>> = {
  OFFEN: 'Akzeptanz offen',
  FREIGEGEBEN: 'akzeptiert',
  ABGELEHNT: 'abgelehnt',
};

export const AKZEPTANZ_STATUS_BADGE: Readonly<Record<AkzeptanzStatus, BadgeKlasse>> = {
  OFFEN: 'badge-purple',
  FREIGEGEBEN: 'badge-green',
  ABGELEHNT: 'badge-red',
};

/** Audit-Aktionen zu Risiken in lesbarer Form (Historie im Detailbereich). */
export const RISIKO_AUDIT_LABEL: Readonly<Record<string, string>> = {
  'tcms.risiko.neu_bewertet': 'Risiko neu bewertet',
  'tcms.risiko.bewertung_bestaetigt': 'Bewertung bestätigt (unverändert)',
  'tcms.risiko.zur_freigabe': 'Zur Freigabe eingereicht',
  'tcms.risiko.freigegeben': 'Bewertung freigegeben (Vier-Augen)',
  'tcms.risiko.zurueckgewiesen': 'Freigabe zurückgewiesen',
  'tcms.risiko.uebersteuerung_beantragt': 'Übersteuerung beantragt',
  'tcms.risiko.uebersteuerung_freigegeben': 'Übersteuerung freigegeben',
  'tcms.risiko.uebersteuerung_abgelehnt': 'Übersteuerung abgelehnt',
  'tcms.risiko.akzeptanz_angefordert': 'Risikoakzeptanz beim Mandanten angefordert',
  'tcms.risiko.uebernommen': 'Risiko übernommen',
  'tcms.risiko.abgelehnt': 'Vorschlag abgelehnt',
};

const KLASSEN: readonly string[] = ['GERING', 'MITTEL', 'HOCH', 'KRITISCH'];
const istKlasse = (x: unknown): x is Klasse => typeof x === 'string' && KLASSEN.includes(x);
const text = (x: unknown) => (typeof x === 'string' ? x : null);
const wahrscheinlichkeit = (x: unknown) =>
  typeof x === 'string' && (WAHRSCHEINLICHKEITEN as readonly string[]).includes(x)
    ? WAHRSCHEINLICHKEIT_LABEL[x as Wahrscheinlichkeit]
    : null;

/**
 * Kurzbeschreibung einer Audit-Zeile aus ihrem Detail (unbekannte Struktur
 * des Dienstes, deshalb nur bekannte Felder mit Typprüfung). Personen-IDs
 * werden über `name` aus der kanzleikonsole aufgelöst, nie roh angezeigt.
 */
export function risikoAuditText(
  detail: Readonly<Record<string, unknown>>,
  name: (id: string | null) => string,
): string {
  const teile: string[] = [];
  const v = detail['vorher'];
  const n = detail['nachher'];
  if (v && n && typeof v === 'object' && typeof n === 'object' && 's' in v && 's' in n) {
    const f = (x: Record<string, unknown>) =>
      [x['s'], wahrscheinlichkeit(x['w']), x['r'], x['gt']]
        .filter((t) => t !== undefined && t !== null && t !== '')
        .join('/');
    teile.push(`${f(v as Record<string, unknown>)} → ${f(n as Record<string, unknown>)}`);
  }
  const sicht = text(detail['sicht']);
  if ((sicht === 'DESIGN' || sicht === 'BETRIEB') && istKlasse(detail['klasse'])) {
    const berechnet = istKlasse(detail['berechnet']) ? KLASSE_LABEL[detail['berechnet']] : '?';
    teile.push(`${SICHT_LABEL[sicht]}: ${berechnet} → ${KLASSE_LABEL[detail['klasse']]}`);
  }
  const empfaenger = text(detail['empfaengerId']);
  if (empfaenger) teile.push(`an ${name(empfaenger)}`);
  const beantragt = text(detail['beantragtVon']) ?? text(detail['eingereichtVon']);
  if (beantragt) teile.push(`beantragt von ${name(beantragt)}`);
  const begruendung = text(detail['begruendung']);
  if (begruendung) teile.push(`„${begruendung}“`);
  return teile.join(' · ');
}

/** Personen-IDs, die `risikoAuditText` auflöst (für die Namensabfrage der Seite). */
export function risikoAuditPersonen(detail: Readonly<Record<string, unknown>>): string[] {
  return ['empfaengerId', 'beantragtVon', 'eingereichtVon'].flatMap((k) => {
    const wert = text(detail[k]);
    return wert ? [wert] : [];
  });
}

/** Text der Matrixzelle GT × Bruttoklasse (Fachkonzept Abschnitt 6, Startwerte). */
export function matrixZelle(gt: GovernanceTyp, brutto: Klasse): string {
  const z = MATRIX_ZEILEN.find((m) => m.gt === gt);
  if (!z) return '—';
  return brutto === 'KRITISCH' || brutto === 'HOCH'
    ? z.hoch
    : brutto === 'MITTEL'
      ? z.mittel
      : z.gering;
}

/**
 * Anzeige-Vorschau „FF · kritisch → monatlich + bei Auslösung“: abgeleitete
 * Mindestfrequenz nach der Häufigkeitsmatrix aus @taxtronik/tcms-domain. Die
 * maßgebliche Frequenz einer Kontrolle berechnet der Dienst (`ableitung`).
 */
export function mindestfrequenzText(gt: GovernanceTyp, brutto: Klasse, turnus: Turnus): string {
  const f = matrixFrequenz(gt, brutto, turnus);
  const zelle = matrixZelle(gt, brutto);
  const konkret = zelle.includes('Periode') ? ` (${frequenzLabel(f)})` : '';
  return `${gt} · ${KLASSE_LABEL[brutto]} → ${zelle}${konkret}`;
}

/** „StB Dr. Anna Roth“ → „Dr. Roth“, „Leon Brandt“ → „L. Brandt“ (Tabellen; voller Name im Tooltip). */
export function kurzName(name: string): string {
  const n = name.replace(/^StB\s+/, '').trim();
  const teile = n.split(/\s+/);
  if (teile.length < 2) return n;
  const nach = teile[teile.length - 1]!;
  if (teile[0] === 'Dr.') return `Dr. ${nach}`;
  return `${teile[0]!.charAt(0)}. ${nach}`;
}

/**
 * Auswahl für den Freigabeschritt im Inventar (Anzeige): bewertete Risiken
 * zum Einreichen, eingereichte zum Freigeben – außer für die Person, die
 * eingereicht hat (Vier-Augen-Anzeige). Sonst der Grund als Tooltip. Ob ein
 * Schritt zulässig ist, entscheidet der Dienst und meldet Übersprungenes.
 */
export function freigabeAuswahl(
  sperre: string | null,
  ich: string,
): (r: Pick<RisikoEintrag, 'freigabe' | 'freigabeEingereichtVon'>) => true | string {
  return (r) => {
    if (sperre) return sperre;
    if (r.freigabe === 'BEWERTET') return true;
    if (r.freigabe === 'ZUR_FREIGABE') {
      const selbst =
        !!r.freigabeEingereichtVon && r.freigabeEingereichtVon.toLowerCase() === ich.toLowerCase();
      return selbst ? 'Von Ihnen eingereicht – die Freigabe erteilt eine zweite Person.' : true;
    }
    return `Status ${RISIKO_FREIGABE_LABEL[r.freigabe]}`;
  };
}
