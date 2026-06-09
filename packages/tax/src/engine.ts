// =============================================================================
// Steuertermin-Engine
//
// Berechnet konkrete Fälligkeiten aus den Steuerschedule-Arten und
// Mandanten-Konfig. Quelle: §§ 18 UStG, 41a EStG, 31 EStG, BMF-Richtlinien.
//
// Regeln (Stand 2026):
//   - USt-Voranmeldung MONATLICH: bis 10. des Folgemonats (Dauerfrist +1 Monat)
//   - USt-Voranmeldung QUARTALSWEISE: bis 10. nach Quartal (Dauerfrist +1 Monat)
//   - USt-Jahreserklärung: 31.07. des Folgejahres (StBerater 28.02. d. übern. J.)
//   - LSt-Anmeldung: gleiches Schema wie USt-VA
//   - ESt/KSt/GewSt-Vorauszahlung: 10.03., 10.06., 10.09., 10.12.
//   - ESt/KSt/GewSt-Erklärung: gesetzlich 31.07. d. Folgejahres
//   - Beratene Fälle (advised, § 149 (3) AO): Erklärung bis zum letzten Tag
//     des Monats Februar des ZWEITEN Folgejahres
//
// Wenn Fälligkeit auf Sa/So/Feiertag fällt, verschiebt sich gem. § 108 (3) AO
// auf den nächsten Werktag. Feiertagslogik: nur Bundesweite (NW-spezifische
// Termine aus Vereinfachungsgründen ignoriert; verbessert sich später).
// =============================================================================

import type { TaxScheduleKind } from '@prisma/client';

export interface DeadlineCandidate {
  kind: TaxScheduleKind;
  period: string;       // YYYY-MM | YYYY-Qn | YYYY
  dueDate: Date;        // konkretes Datum nach Werktagsverschiebung
}

/**
 * Liefert alle Fälligkeiten einer Schedule-Art im Bereich [from, to].
 * Der Bereich gilt für das KONKRETE (werktagsverschobene) Fälligkeitsdatum —
 * alle Zweige prüfen das verschobene Datum gegen [from, to].
 *
 * `region` wird für die Werktagsverschiebung verwendet (überspringt
 * landesspezifische Feiertage gemäß Sitz der Kanzlei). Wenn null:
 * nur bundeseinheitliche Feiertage.
 *
 * `advised`: beratene Erklärungsfrist nach § 149 (3) AO — letzter Tag des
 * Monats Februar des ZWEITEN Folgejahres statt 31.07. des Folgejahres.
 * Wirkt nur auf die Erklärungs-/Jahres-Arten. Default false = bisheriges
 * Verhalten (nicht-beratene Frist).
 */
export function generateDeadlines(
  kind: TaxScheduleKind,
  from: Date,
  to: Date,
  hasDauerfrist: boolean,
  region: GermanRegion | null = null,
  advised = false,
): DeadlineCandidate[] {
  const out: DeadlineCandidate[] = [];
  switch (kind) {
    case 'USTA_MONATLICH':
    case 'LSTA_MONATLICH':
      iterateMonths(from, to, (year, month) => {
        const period = `${year}-${pad(month)}`;
        const due = shiftToNextWorkday(monthlyVaDueDate(year, month, hasDauerfrist), region);
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;

    case 'USTA_QUARTAL':
    case 'LSTA_QUARTAL':
      iterateQuarters(from, to, (year, q) => {
        const period = `${year}-Q${q}`;
        const due = shiftToNextWorkday(quarterlyVaDueDate(year, q, hasDauerfrist), region);
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;

    case 'EST_VZ':
    case 'KST_VZ':
    case 'GEWST_VZ':
      // 10.03., 10.06., 10.09., 10.12.
      iterateYears(from, to, (year) => {
        for (const month of [3, 6, 9, 12]) {
          const due = shiftToNextWorkday(new Date(Date.UTC(year, month - 1, 10)), region);
          if (due >= from && due <= to) {
            const q = Math.ceil(month / 3);
            out.push({ kind, period: `${year}-Q${q}`, dueDate: due });
          }
        }
      });
      break;

    case 'USTA_JAEHRLICH':
    case 'EST_ERKLAERUNG':
    case 'KST_ERKLAERUNG':
    case 'GEWST_ERKLAERUNG':
    case 'LSTA_JAEHRLICH':
      // Gesetzliche Frist: 31.07. des Folgejahres (gilt für 2025+ wieder).
      // Beratene Fälle (§ 149 (3) AO): letzter Tag des Monats Februar des
      // ZWEITEN Folgejahres — Date.UTC(year, 2, 0) ist Schaltjahr-sicher
      // (Tag 0 im März = 28. oder 29. Februar).
      iterateYears(from, to, (year) => {
        // Der Termin gehört zum *Veranlagungsjahr* (Vorjahr, bei beratener
        // Frist Vor-Vorjahr), fällt aber im "year" an.
        const period = advised ? `${year - 2}` : `${year - 1}`;
        const due = shiftToNextWorkday(
          advised
            ? new Date(Date.UTC(year, 2, 0)) // letzter Februartag
            : new Date(Date.UTC(year, 6, 31)), // 31.07.
          region,
        );
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 10. des Folgemonats; mit Dauerfrist +1 Monat (so endet Januar-VA am 10.03.
 * statt 10.02.).
 */
function monthlyVaDueDate(year: number, month: number, dauerfrist: boolean): Date {
  // month 1-12 = berichtszeitraum. Fälligkeit im Folgemonat (oder +2 mit Dauer).
  const offset = dauerfrist ? 2 : 1;
  const dueMonth0 = month - 1 + offset; // month-1 weil JS-month 0-basiert
  return new Date(Date.UTC(year, dueMonth0, 10));
}

function quarterlyVaDueDate(year: number, quarter: number, dauerfrist: boolean): Date {
  // Q1 endet 31.03., Fälligkeit 10.04. (mit Dauer 10.05.)
  const monthAfterQuarter = quarter * 3; // Q1=3, Q2=6, Q3=9, Q4=12 → +1 für Folgemonat
  const offset = dauerfrist ? 2 : 1;
  const dueMonth0 = monthAfterQuarter - 1 + offset;
  return new Date(Date.UTC(year, dueMonth0, 10));
}

function iterateMonths(from: Date, to: Date, cb: (year: number, month: number) => void): void {
  // Wir iterieren über *Berichtszeiträume* — alle Monate, deren Fälligkeit
  // im [from..to]-Bereich liegen könnte. Wir gehen 3 Monate weiter zurück
  // als from, damit auch der Berichtsmonat erfasst wird, dessen Termin
  // im Bereich liegt.
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 3, 1));
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  while (true) {
    const tryDate = new Date(Date.UTC(y, m - 1, 1));
    if (tryDate > to) break;
    cb(y, m);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
}

function iterateQuarters(from: Date, to: Date, cb: (year: number, quarter: number) => void): void {
  const startYear = from.getUTCFullYear() - 1;
  const endYear = to.getUTCFullYear() + 1;
  for (let y = startYear; y <= endYear; y++) {
    for (let q = 1; q <= 4; q++) {
      cb(y, q);
    }
  }
}

function iterateYears(from: Date, to: Date, cb: (year: number) => void): void {
  for (let y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear() + 1; y++) {
    cb(y);
  }
}

// ---------------------------------------------------------------------------
// Feiertage pro Bundesland — ISO-3166-2:DE-Codes
// ---------------------------------------------------------------------------

export type GermanRegion =
  | 'DE-BW' | 'DE-BY' | 'DE-BE' | 'DE-BB' | 'DE-HB' | 'DE-HH' | 'DE-HE'
  | 'DE-MV' | 'DE-NI' | 'DE-NW' | 'DE-RP' | 'DE-SL' | 'DE-SN' | 'DE-ST'
  | 'DE-SH' | 'DE-TH';

export const REGION_LABELS: Record<GermanRegion, string> = {
  'DE-BW': 'Baden-Württemberg',
  'DE-BY': 'Bayern',
  'DE-BE': 'Berlin',
  'DE-BB': 'Brandenburg',
  'DE-HB': 'Bremen',
  'DE-HH': 'Hamburg',
  'DE-HE': 'Hessen',
  'DE-MV': 'Mecklenburg-Vorpommern',
  'DE-NI': 'Niedersachsen',
  'DE-NW': 'Nordrhein-Westfalen',
  'DE-RP': 'Rheinland-Pfalz',
  'DE-SL': 'Saarland',
  'DE-SN': 'Sachsen',
  'DE-ST': 'Sachsen-Anhalt',
  'DE-SH': 'Schleswig-Holstein',
  'DE-TH': 'Thüringen',
};

/**
 * Verschiebt Datum auf den nächsten Werktag (Mo–Fr) und überspringt
 * gesetzliche Feiertage. Wenn `region` gesetzt ist, werden auch die
 * bundeslandspezifischen Feiertage berücksichtigt.
 */
export function shiftToNextWorkday(date: Date, region?: GermanRegion | null): Date {
  let d = new Date(date.getTime());
  while (isWeekendOrHoliday(d, region ?? null)) {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return d;
}

// ---------------------------------------------------------------------------
// § 108 (1) AO — Tagesgrenzen
//
// `dueDate` wird als UTC-Mitternacht gespeichert (@db.Date). Die Frist läuft
// aber bis zum ENDE des Fälligkeitstags: ein heute fälliger Termin ist weder
// retrospektiv noch überfällig.
// ---------------------------------------------------------------------------

/** Ende des Fälligkeitstags (23:59:59.999 UTC) — bis dahin ist die Frist gewahrt. */
export function endOfDueDay(dueDate: Date): Date {
  return new Date(Date.UTC(
    dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate(),
    23, 59, 59, 999,
  ));
}

/** UTC-Mitternacht des Tages von `d` — nur Termine mit dueDate DAVOR sind überfällig. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isWeekendOrHoliday(d: Date, region: GermanRegion | null): boolean {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return true;
  return germanHolidays(d.getUTCFullYear(), region).some(
    (h) =>
      h.getUTCFullYear() === d.getUTCFullYear() &&
      h.getUTCMonth() === d.getUTCMonth() &&
      h.getUTCDate() === d.getUTCDate(),
  );
}

/**
 * Liefert alle Feiertage eines Jahres. Bundeseinheitliche immer; bei
 * gesetztem `region` zusätzlich die landesspezifischen.
 *
 * Quelle: Feiertagsgesetze der Länder, Stand 2025.
 */
export function germanHolidays(year: number, region: GermanRegion | null): Date[] {
  const easter = easterSunday(year);
  const ms = 24 * 60 * 60 * 1000;

  // Bundeseinheitliche Feiertage
  const out: Date[] = [
    new Date(Date.UTC(year, 0, 1)),       // Neujahr
    new Date(easter.getTime() - 2 * ms),   // Karfreitag
    new Date(easter.getTime() + 1 * ms),   // Ostermontag
    new Date(Date.UTC(year, 4, 1)),       // Tag der Arbeit
    new Date(easter.getTime() + 39 * ms),  // Christi Himmelfahrt
    new Date(easter.getTime() + 50 * ms),  // Pfingstmontag
    new Date(Date.UTC(year, 9, 3)),       // Tag der Deutschen Einheit
    new Date(Date.UTC(year, 11, 25)),     // 1. Weihnachtstag
    new Date(Date.UTC(year, 11, 26)),     // 2. Weihnachtstag
  ];

  if (!region) return out;

  // Landesspezifisch
  const epiphany = new Date(Date.UTC(year, 0, 6));            // Heilige Drei Könige
  const womenDay = new Date(Date.UTC(year, 2, 8));            // Internationaler Frauentag
  const corpusChristi = new Date(easter.getTime() + 60 * ms); // Fronleichnam
  const assumption = new Date(Date.UTC(year, 7, 15));         // Mariä Himmelfahrt
  const worldChildren = new Date(Date.UTC(year, 8, 20));      // Weltkindertag
  const reformation = new Date(Date.UTC(year, 9, 31));        // Reformationstag
  const allSaints = new Date(Date.UTC(year, 10, 1));          // Allerheiligen
  const repentance = wednesdayBefore(new Date(Date.UTC(year, 10, 23))); // Buß- und Bettag

  switch (region) {
    case 'DE-BW':
      out.push(epiphany, corpusChristi, allSaints);
      break;
    case 'DE-BY':
      out.push(epiphany, corpusChristi, assumption, allSaints);
      break;
    case 'DE-BE':
      out.push(womenDay);
      break;
    case 'DE-BB':
      out.push(reformation);
      break;
    case 'DE-HB':
      out.push(reformation);
      break;
    case 'DE-HH':
      out.push(reformation);
      break;
    case 'DE-HE':
      out.push(corpusChristi);
      break;
    case 'DE-MV':
      out.push(womenDay, reformation);
      break;
    case 'DE-NI':
      out.push(reformation);
      break;
    case 'DE-NW':
      out.push(corpusChristi, allSaints);
      break;
    case 'DE-RP':
      out.push(corpusChristi, allSaints);
      break;
    case 'DE-SL':
      out.push(corpusChristi, assumption, allSaints);
      break;
    case 'DE-SN':
      out.push(reformation, repentance);
      break;
    case 'DE-ST':
      out.push(epiphany, reformation);
      break;
    case 'DE-SH':
      out.push(reformation);
      break;
    case 'DE-TH':
      out.push(worldChildren, reformation);
      break;
  }
  return out;
}

/**
 * Letzter Mittwoch STRIKT vor `date`. Buß- und Bettag ist der Mittwoch VOR
 * dem 23.11. — fällt der 23.11. selbst auf einen Mittwoch (z. B. 2022, 2033),
 * ist es der 16.11., nicht der 23.11.
 */
function wednesdayBefore(date: Date): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() - 1); // strikt davor: `date` selbst zählt nicht
  while (d.getUTCDay() !== 3) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

/**
 * Gauß-Algorithmus für Ostersonntag (gregorianischer Kalender).
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

export const SCHEDULE_LABELS: Record<TaxScheduleKind, string> = {
  USTA_MONATLICH: 'USt-Voranmeldung (monatlich)',
  USTA_QUARTAL: 'USt-Voranmeldung (quartalsweise)',
  USTA_JAEHRLICH: 'USt-Jahreserklärung',
  LSTA_MONATLICH: 'Lohnsteuer-Anmeldung (monatlich)',
  LSTA_QUARTAL: 'Lohnsteuer-Anmeldung (quartalsweise)',
  LSTA_JAEHRLICH: 'Lohnsteuer-Anmeldung (jährlich)',
  EST_VZ: 'ESt-Vorauszahlung',
  KST_VZ: 'KSt-Vorauszahlung',
  GEWST_VZ: 'GewSt-Vorauszahlung',
  EST_ERKLAERUNG: 'ESt-Erklärung',
  KST_ERKLAERUNG: 'KSt-Erklärung',
  GEWST_ERKLAERUNG: 'GewSt-Erklärung',
};
