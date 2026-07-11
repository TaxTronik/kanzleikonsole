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
//   - LSt-Anmeldung (monatlich/quartalsweise): gleiches Schema wie USt-VA
//   - LSt-Anmeldung JÄHRLICH (§ 41a (1) EStG): 10.01. des Folgejahres — eine
//     Steuer-ANMELDUNG, daher gilt die 10-Tage-Frist, NICHT die 31.07.-
//     Erklärungsfrist und NICHT § 149 (3) AO (advised wirkt hier nicht).
//   - ESt/KSt-Vorauszahlung (§ 37 EStG): 10.03., 10.06., 10.09., 10.12.
//   - GewSt-Vorauszahlung (§ 19 (1) GewStG): 15.02., 15.05., 15.08., 15.11.
//   - ESt/KSt/GewSt-Erklärung: gesetzlich 31.07. d. Folgejahres
//   - Beratene Fälle (advised, § 149 (3) AO): Erklärung bis zum letzten Tag
//     des Monats Februar des ZWEITEN Folgejahres
//   - Übergangsrecht Art. 97 § 36 Abs. 3 EGAO (Corona): abweichende
//     Erklärungsfristen für die VZ 2020–2024 (s. EGAO_ERKLAERUNG_*)
//
// Wenn Fälligkeit auf Sa/So/Feiertag fällt, verschiebt sich gem. § 108 (3) AO
// auf den nächsten Werktag. Feiertagslogik: bundeseinheitliche Feiertage
// immer; mit gesetztem `region` zusätzlich die landesspezifischen.
// =============================================================================

import type { TaxScheduleKind } from '@prisma/client';

export interface DeadlineCandidate {
  kind: TaxScheduleKind;
  period: string; // YYYY-MM | YYYY-Qn | YYYY
  dueDate: Date; // konkretes Datum nach Werktagsverschiebung
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
  // Begeht der Kanzleisitz Mariä Himmelfahrt? Nur in DE-BY relevant (Default an);
  // false verhindert die Werktagsverschiebung eines auf den 15.08. fallenden
  // Termins in protestantisch geprägten bayerischen Gemeinden. Siehe germanHolidays.
  bavariaAssumption = true,
): DeadlineCandidate[] {
  const out: DeadlineCandidate[] = [];
  const shift = (d: Date) => shiftToNextWorkday(d, region, bavariaAssumption);
  switch (kind) {
    case 'USTA_MONATLICH':
      iterateMonths(from, to, (year, month) => {
        const period = `${year}-${pad(month)}`;
        const due = shift(monthlyVaDueDate(year, month, hasDauerfrist));
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;

    case 'LSTA_MONATLICH':
      // § 41a Abs. 1 EStG: 10. des Folgemonats. KEINE Dauerfristverlaengerung —
      // die gibt es ausschliesslich fuer USt-Voranmeldungen (§ 18 Abs. 6 UStG,
      // §§ 46-48 UStDV). hasDauerfrist wird hier bewusst ignoriert.
      iterateMonths(from, to, (year, month) => {
        const period = `${year}-${pad(month)}`;
        const due = shift(monthlyVaDueDate(year, month, false));
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;

    case 'USTA_QUARTAL':
      iterateQuarters(from, to, (year, q) => {
        const period = `${year}-Q${q}`;
        const due = shift(quarterlyVaDueDate(year, q, hasDauerfrist));
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;

    case 'LSTA_QUARTAL':
      // § 41a Abs. 1 EStG: 10. nach Quartalsende. KEINE Dauerfrist (s. o.).
      iterateQuarters(from, to, (year, q) => {
        const period = `${year}-Q${q}`;
        const due = shift(quarterlyVaDueDate(year, q, false));
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;

    case 'EST_VZ':
    case 'KST_VZ':
      // § 37 EStG: 10.03., 10.06., 10.09., 10.12.
      iterateYears(from, to, (year) => {
        for (const month of [3, 6, 9, 12]) {
          const due = shift(new Date(Date.UTC(year, month - 1, 10)));
          if (due >= from && due <= to) {
            const q = Math.ceil(month / 3);
            out.push({ kind, period: `${year}-Q${q}`, dueDate: due });
          }
        }
      });
      break;

    case 'GEWST_VZ':
      // § 19 (1) GewStG: 15.02., 15.05., 15.08., 15.11. — eigene, von § 37 EStG
      // abweichende Termine (NICHT 10.03./06./09./12.).
      iterateYears(from, to, (year) => {
        for (const month of [2, 5, 8, 11]) {
          const due = shift(new Date(Date.UTC(year, month - 1, 15)));
          if (due >= from && due <= to) {
            const q = Math.ceil(month / 3);
            out.push({ kind, period: `${year}-Q${q}`, dueDate: due });
          }
        }
      });
      break;

    case 'LSTA_JAEHRLICH':
      // § 41a (1) EStG: jährliche Lohnsteuer-ANMELDUNG bis 10.01. des
      // Folgejahres. Anmeldungszeitraum ist das Kalenderjahr (year - 1), die
      // Frist fällt in `year`. advised (§ 149 (3) AO) gilt für Anmeldungen NICHT.
      iterateYears(from, to, (year) => {
        const period = `${year - 1}`;
        const due = shift(new Date(Date.UTC(year, 0, 10)));
        if (due >= from && due <= to) {
          out.push({ kind, period, dueDate: due });
        }
      });
      break;

    case 'USTA_JAEHRLICH':
    case 'EST_ERKLAERUNG':
    case 'KST_ERKLAERUNG':
    case 'GEWST_ERKLAERUNG':
      // Gesetzliche Frist: 31.07. des Folgejahres (gilt ab VZ 2024 wieder).
      // Beratene Fälle (§ 149 (3) AO): letzter Tag des Monats Februar des
      // ZWEITEN Folgejahres — Date.UTC(year, 2, 0) ist Schaltjahr-sicher
      // (Tag 0 im März = 28. oder 29. Februar).
      // VZ 2020–2024: verlängerte Fristen nach Art. 97 § 36 Abs. 3 EGAO
      // (Override-Tabellen unten; § 108 (3) AO wird danach normal angewandt).
      iterateYears(from, to, (year) => {
        // Der Termin gehört zum *Veranlagungsjahr* (Vorjahr, bei beratener
        // Frist Vor-Vorjahr), fällt aber im "year" an. Die EGAO-Fristen
        // verlängern nur Monat/Tag, nie über die Jahresgrenze hinaus — die
        // Jahr→Periode-Zuordnung bleibt deshalb auch für sie korrekt.
        const periodYear = advised ? year - 2 : year - 1;
        const egao = (advised ? EGAO_ERKLAERUNG_BERATEN : EGAO_ERKLAERUNG_NICHT_BERATEN)[
          periodYear
        ];
        const basis = egao
          ? new Date(Date.UTC(year, egao[0], egao[1]))
          : advised
            ? new Date(Date.UTC(year, 2, 0)) // letzter Februartag
            : new Date(Date.UTC(year, 6, 31)); // 31.07.
        const due = shift(basis);
        if (due >= from && due <= to) {
          out.push({ kind, period: `${periodYear}`, dueDate: due });
        }
      });
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Art. 97 § 36 Abs. 3 EGAO — Corona-bedingt verlängerte Erklärungsfristen.
//
// Gesetzliche BASIS-Termine (vor § 108 (3)-Verschiebung) je Veranlagungs-
// zeitraum, als [Monat 0-basiert, Tag] im Fälligkeitsjahr. Ab VZ 2024 (nicht
// beraten) bzw. VZ 2025 (beraten) gelten wieder die Regelfristen des § 149 AO.
// ---------------------------------------------------------------------------

/** Nicht beratene Fälle: VZ → Basis-Termin. VZ 2020: 31.10.2021 (So, § 108 (3)
 * → 01./02.11. je nach Land); VZ 2021: 31.10.2022; VZ 2022: 30.09.2023 (Sa →
 * 02.10.2023); VZ 2023: 31.08.2024 (Sa → 02.09.2024). */
const EGAO_ERKLAERUNG_NICHT_BERATEN: Record<number, [number, number]> = {
  2020: [9, 31],
  2021: [9, 31],
  2022: [8, 30],
  2023: [7, 31],
};

/** Beratene Fälle (§ 149 (3) AO): VZ 2020: 31.08.2022; VZ 2021: 31.08.2023;
 * VZ 2022: 31.07.2024; VZ 2023: 31.05.2025 (Sa → 02.06.2025);
 * VZ 2024: 30.04.2026. */
const EGAO_ERKLAERUNG_BERATEN: Record<number, [number, number]> = {
  2020: [7, 31],
  2021: [7, 31],
  2022: [6, 31],
  2023: [4, 31],
  2024: [3, 30],
};

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
  | 'DE-BW'
  | 'DE-BY'
  | 'DE-BE'
  | 'DE-BB'
  | 'DE-HB'
  | 'DE-HH'
  | 'DE-HE'
  | 'DE-MV'
  | 'DE-NI'
  | 'DE-NW'
  | 'DE-RP'
  | 'DE-SL'
  | 'DE-SN'
  | 'DE-ST'
  | 'DE-SH'
  | 'DE-TH';

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
export function shiftToNextWorkday(
  date: Date,
  region?: GermanRegion | null,
  bavariaAssumption = true,
): Date {
  let d = new Date(date.getTime());
  while (isWeekendOrHoliday(d, region ?? null, bavariaAssumption)) {
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

const berlinDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const berlinWallClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * UTC-Mitternacht des Berlin-Kalendertags, in dem `instant` liegt. Das ist die
 * Kodierung unserer `@db.Date`-Spalten und deshalb die sichere Vergleichsgröße
 * für „heute fällig“/„ab morgen überfällig“ — auch zwischen 22:00 und 24:00 UTC
 * während der Sommerzeit.
 */
export function berlinCalendarDate(instant: Date): Date {
  const parts = Object.fromEntries(
    berlinDateFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function berlinUtcOffsetMs(instant: Date): number {
  const parts = Object.fromEntries(
    berlinWallClockFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const instantAtWholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return wallClockAsUtc - instantAtWholeSecond;
}

/** Wandelt einen als UTC-Mitternacht kodierten Berlin-Kalendertag in den echten Instant um. */
function berlinMidnightInstant(calendarDate: Date): Date {
  const wallClockMidnight = Date.UTC(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth(),
    calendarDate.getUTCDate(),
  );
  // Zweimalige Offset-Auflösung deckt auch den Wechsel CET↔CEST ab. In Berlin
  // findet der Wechsel nicht um Mitternacht statt; der Zielzeitpunkt ist daher
  // eindeutig.
  let instant = new Date(wallClockMidnight - 60 * 60 * 1000);
  for (let i = 0; i < 2; i += 1) {
    instant = new Date(wallClockMidnight - berlinUtcOffsetMs(instant));
  }
  return instant;
}

/** Ende des Fälligkeitstags in Europe/Berlin — bis dahin ist die Frist gewahrt. */
export function endOfDueDay(dueDate: Date): Date {
  const nextCalendarDay = new Date(
    Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate() + 1),
  );
  return new Date(berlinMidnightInstant(nextCalendarDay).getTime() - 1);
}

/** UTC-Mitternacht des Tages von `d` — nur Termine mit dueDate DAVOR sind überfällig. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Einspruchsfrist (§ 355 Abs. 1 AO): ein Monat nach Bekanntgabe des Bescheids.
//
// Bekanntgabefiktion § 122 Abs. 2 Nr. 1 AO (Fassung ab 01.01.2025,
// Postrechtsmodernisierungsgesetz): ein schriftlicher Verwaltungsakt gilt am
// VIERTEN Tag nach Aufgabe zur Post als bekannt gegeben (bis 31.12.2024: dritter
// Tag). Fällt dieser Tag auf Sa/So/Feiertag, verschiebt er sich auf den nächsten
// Werktag (§ 108 Abs. 3 AO, st. BFH-Rspr.).
//
// Die Monatsfrist wird kalendarisch nach §§ 187 Abs. 1, 188 Abs. 2 BGB gerechnet:
// der Bekanntgabetag zählt nicht mit, die Frist endet mit Ablauf des Tages des
// Folgemonats, der dem Bekanntgabetag zahlenmäßig entspricht; existiert dieser
// Tag im Folgemonat nicht (z. B. 31. → Februar), endet sie am letzten Tag des
// Folgemonats. Fällt das Fristende auf Sa/So/Feiertag → nächster Werktag
// (§ 108 Abs. 3 AO).
//
// NICHT die frühere Näherung „+ 33 Tage": die ist zweifach falsch (3 statt 4
// Tage Fiktion; 30 Tage statt kalendarischer Monat) und kann eine SPÄTERE Frist
// ausweisen als die gesetzliche — mit Bestandskraft-/Haftungsrisiko.
// ---------------------------------------------------------------------------

/** Kalendarische Bekanntgabefiktion ab 01.01.2025: +4 Tage. Davor: +3. */
export const BEKANNTGABE_FIKTION_TAGE = 4;

/**
 * Fiktionstage abhängig vom Bescheiddatum: Das Postrechtsmodernisierungs-
 * gesetz gilt für Verwaltungsakte, die ab dem 01.01.2025 zur Post gegeben
 * wurden (Art. 97 § 1 Abs. 16 EGAO). Für nacherfasste Alt-Bescheide
 * (Aufgabe bis 31.12.2024) gilt weiterhin die Drei-Tages-Fiktion.
 */
export function bekanntgabeFiktionTage(noticeDate: Date): number {
  return noticeDate.getTime() < Date.UTC(2025, 0, 1) ? 3 : BEKANNTGABE_FIKTION_TAGE;
}

/**
 * Berechnet die Einspruchsfrist eines Steuerbescheids aus dem Bescheiddatum
 * (Tag der Aufgabe zur Post, als UTC-Mitternacht).
 *
 * `receivedAt` (optional): TATSÄCHLICHER Zugangstag beim Empfänger. § 122
 * Abs. 2 AO: die Fiktion gilt, „außer wenn der Verwaltungsakt nicht oder zu
 * einem SPÄTEREN Zeitpunkt zugegangen ist" — kam der Bescheid später an
 * (Postverzögerung, liegengeblieben), beginnt die Monatsfrist erst mit dem
 * echten Zugang. Ein FRÜHERER tatsächlicher Zugang verkürzt die Frist dagegen
 * NICHT (die Fiktion ist Mindestschutz; st. Rspr.). Der tatsächliche Zugang
 * ist ein Faktum und wird nicht werktagsverschoben — nur Fiktionstag und
 * Fristende unterliegen § 108 Abs. 3 AO.
 *
 * `region`: Standard `null` = nur bundeseinheitliche Feiertage. Bewusst
 * konservativ — würde man Landesfeiertage annehmen, verschöbe sich die Frist
 * eher nach hinten; `null` wahrt die Frist eher zu früh als zu spät.
 */
export function appealDeadline(
  noticeDate: Date,
  region: GermanRegion | null = null,
  receivedAt: Date | null = null,
  legalRemedyInstructionValid = true,
): Date {
  // 1. Bekanntgabe: + Fiktionstage (datumsabhängig: 3 bis 2024, 4 ab 2025),
  //    dann Werktagsverschiebung.
  const fiktion = new Date(
    Date.UTC(
      noticeDate.getUTCFullYear(),
      noticeDate.getUTCMonth(),
      noticeDate.getUTCDate() + bekanntgabeFiktionTage(noticeDate),
    ),
  );
  let bekanntgabe = shiftToNextWorkday(fiktion, region);

  // Tatsächlich SPÄTER zugegangen → echter Zugangstag ist maßgeblich.
  if (receivedAt) {
    const received = startOfUtcDay(receivedAt);
    if (received.getTime() > bekanntgabe.getTime()) bekanntgabe = received;
  }

  return appealDeadlineFromNotification(bekanntgabe, region, legalRemedyInstructionValid);
}

/**
 * Einspruchsfrist ab einem bereits feststehenden Bekanntgabetag. Für
 * förmliche, persönliche oder anderweitig nachgewiesene Bekanntgaben darf die
 * Postfiktion nicht aufgeschlagen werden. Bei fehlender/unrichtiger
 * Rechtsbehelfsbelehrung gilt grundsätzlich die Jahresfrist des § 356 Abs. 2 AO.
 */
export function appealDeadlineFromNotification(
  notificationDate: Date,
  region: GermanRegion | null = null,
  legalRemedyInstructionValid = true,
): Date {
  const start = startOfUtcDay(notificationDate);
  return legalRemedyInstructionValid
    ? addMonthWithWorkdayShift(start, region)
    : addYearWithWorkdayShift(start, region);
}

/**
 * Einspruchsfrist bei postalischer Übermittlung ins Ausland (§ 122 Abs. 2
 * Nr. 2 AO): Bekanntgabefiktion einen Monat nach Aufgabe zur Post; ein
 * nachweislich späterer Zugang geht vor.
 */
export function appealDeadlineForPostAbroad(
  sentAt: Date,
  region: GermanRegion | null = null,
  receivedAt: Date | null = null,
  legalRemedyInstructionValid = true,
): Date {
  let notificationDate = addMonthWithWorkdayShift(startOfUtcDay(sentAt), region);
  if (receivedAt) {
    const received = startOfUtcDay(receivedAt);
    if (received > notificationDate) notificationDate = received;
  }
  return appealDeadlineFromNotification(notificationDate, region, legalRemedyInstructionValid);
}

/**
 * Addiert einen Monat (kalendarisch nach BGB, monatsende-sicher) auf einen
 * bereits feststehenden Fristbeginn und verschiebt das Fristende nach § 108
 * Abs. 3 AO auf den nächsten Werktag. Gemeinsamer Kern von Einspruchs- und
 * Klagefrist — der Unterschied liegt nur im Fristbeginn (Einspruch: Bescheid +
 * Bekanntgabefiktion; Klage: bereits die Bekanntgabe der Einspruchsentscheidung).
 */
function addMonthWithWorkdayShift(start: Date, region: GermanRegion | null): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  let ende = new Date(Date.UTC(y, m + 1, d));
  // Überlauf: existiert der Tag im Zielmonat nicht (z. B. 31.01. → 31.02.),
  // rollt JS in den übernächsten Monat — dann auf den letzten Tag des
  // Zielmonats (m+1) zurücksetzen. `Date.UTC(y, m+2, 0)` = Tag 0 von (m+2) =
  // letzter Tag von (m+1).
  if (ende.getUTCMonth() !== (m + 1) % 12) {
    ende = new Date(Date.UTC(y, m + 2, 0));
  }
  return shiftToNextWorkday(ende, region);
}

function addYearWithWorkdayShift(start: Date, region: GermanRegion | null): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  let ende = new Date(Date.UTC(y + 1, m, d));
  // 29.02. → letzter Tag des Februar im Folgejahr.
  if (ende.getUTCMonth() !== m) {
    ende = new Date(Date.UTC(y + 1, m + 1, 0));
  }
  return shiftToNextWorkday(ende, region);
}

/**
 * Klagefrist (§ 47 Abs. 1 FGO, 1 Monat) ab BEKANNTGABE der
 * Einspruchsentscheidung.
 *
 * WICHTIG — Unterschied zu {@link appealDeadline}: Das Argument ist hier bereits
 * der Bekanntgabetag der Einspruchsentscheidung, NICHT das Bescheiddatum. Die
 * § 122 Abs. 2 AO-Bekanntgabefiktion darf deshalb NICHT erneut aufgeschlagen
 * werden — sonst liefe die Klagefrist um die Fiktionstage (3–4 Werktage) zu
 * spät, was bei einem Fristenkontrolltool die gefährliche Richtung ist. Nur
 * + 1 Monat + § 108 Abs. 3 AO-Werktagsverschiebung ab dem Bekanntgabetag.
 */
export function klageDeadline(
  bekanntgabe: Date,
  region: GermanRegion | null = null,
  legalRemedyInstructionValid = true,
): Date {
  const start = startOfUtcDay(bekanntgabe);
  return legalRemedyInstructionValid
    ? addMonthWithWorkdayShift(start, region)
    : addYearWithWorkdayShift(start, region);
}

function isWeekendOrHoliday(
  d: Date,
  region: GermanRegion | null,
  bavariaAssumption = true,
): boolean {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return true;
  return germanHolidays(d.getUTCFullYear(), region, bavariaAssumption).some(
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
export function germanHolidays(
  year: number,
  region: GermanRegion | null,
  bavariaAssumption = true,
): Date[] {
  const easter = easterSunday(year);
  const ms = 24 * 60 * 60 * 1000;

  // Bundeseinheitliche Feiertage
  const out: Date[] = [
    new Date(Date.UTC(year, 0, 1)), // Neujahr
    new Date(easter.getTime() - 2 * ms), // Karfreitag
    new Date(easter.getTime() + ms), // Ostermontag
    new Date(Date.UTC(year, 4, 1)), // Tag der Arbeit
    new Date(easter.getTime() + 39 * ms), // Christi Himmelfahrt
    new Date(easter.getTime() + 50 * ms), // Pfingstmontag
    new Date(Date.UTC(year, 9, 3)), // Tag der Deutschen Einheit
    new Date(Date.UTC(year, 11, 25)), // 1. Weihnachtstag
    new Date(Date.UTC(year, 11, 26)), // 2. Weihnachtstag
  ];

  if (!region) return out;

  // Landesspezifisch
  const epiphany = new Date(Date.UTC(year, 0, 6)); // Heilige Drei Könige
  const womenDay = new Date(Date.UTC(year, 2, 8)); // Internationaler Frauentag
  const corpusChristi = new Date(easter.getTime() + 60 * ms); // Fronleichnam
  const assumption = new Date(Date.UTC(year, 7, 15)); // Mariä Himmelfahrt
  const worldChildren = new Date(Date.UTC(year, 8, 20)); // Weltkindertag
  const reformation = new Date(Date.UTC(year, 9, 31)); // Reformationstag
  const allSaints = new Date(Date.UTC(year, 10, 1)); // Allerheiligen
  const repentance = wednesdayBefore(new Date(Date.UTC(year, 10, 23))); // Buß- und Bettag

  switch (region) {
    case 'DE-BW':
      out.push(epiphany, corpusChristi, allSaints);
      break;
    case 'DE-BY':
      out.push(epiphany, corpusChristi, allSaints);
      // Mariä Himmelfahrt ist in Bayern NUR in Gemeinden mit überwiegend
      // katholischer Bevölkerung gesetzlicher Feiertag (Art. 1 Abs. 1 BayFTG) —
      // der Tenant steuert das per tax_assumption_holiday (Default an).
      if (bavariaAssumption) out.push(assumption);
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
