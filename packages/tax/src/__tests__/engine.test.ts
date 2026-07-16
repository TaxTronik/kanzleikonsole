// =============================================================================
// Unit-Tests für Tax-Deadline-Engine
//
// Kritische Pfade:
//   - § 108 (3) AO Werktagsverschiebung (Sa/So + Feiertage)
//   - Bewegliche Feiertage via Gauß-Osteralgorithmus
//   - Landesspezifische Feiertage
//   - Dauerfristverlängerung bei USt/LSt
//   - USt-VA monatlich/quartalsweise + ESt/KSt/GewSt-VZ + Erklärungen
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  endOfDueDay,
  berlinCalendarDate,
  berlinTodayUtcMidnight,
  generateDeadlines,
  germanHolidays,
  SCHEDULE_LABELS,
  shiftToNextWorkday,
  startOfUtcDay,
} from '../index';

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

describe('germanHolidays — bundesweit', () => {
  it('liefert 9 bundeseinheitliche Feiertage 2025', () => {
    const out = germanHolidays(2025, null).map(ymd).sort();
    expect(out).toEqual([
      '2025-01-01', // Neujahr
      '2025-04-18', // Karfreitag
      '2025-04-21', // Ostermontag
      '2025-05-01', // Tag der Arbeit
      '2025-05-29', // Christi Himmelfahrt
      '2025-06-09', // Pfingstmontag
      '2025-10-03', // Tag der Deutschen Einheit
      '2025-12-25', // 1. Weihnachtstag
      '2025-12-26', // 2. Weihnachtstag
    ]);
  });

  it('Ostern 2026 = 5. April (Gauß-Algorithmus)', () => {
    const out = germanHolidays(2026, null).map(ymd);
    // Karfreitag = Osterso - 2 = 3. April 2026
    expect(out).toContain('2026-04-03');
    // Ostermontag = Osterso + 1 = 6. April 2026
    expect(out).toContain('2026-04-06');
  });

  it('Ostern 2030 = 21. April', () => {
    const out = germanHolidays(2030, null).map(ymd);
    expect(out).toContain('2030-04-19'); // Karfreitag
    expect(out).toContain('2030-04-22'); // Ostermontag
  });
});

describe('germanHolidays — landesspezifisch', () => {
  it('NRW hat Fronleichnam und Allerheiligen zusätzlich (2025)', () => {
    const base = germanHolidays(2025, null);
    const nrw = germanHolidays(2025, 'DE-NW');
    expect(nrw.length).toBe(base.length + 2);
    const nrwDates = nrw.map(ymd);
    expect(nrwDates).toContain('2025-06-19'); // Fronleichnam (Osterso + 60)
    expect(nrwDates).toContain('2025-11-01'); // Allerheiligen
  });

  it('Bayern hat zusätzlich 4 Tage (Heilige Drei Könige, Fronleichnam, Mariä Himmelfahrt, Allerheiligen)', () => {
    const bayern = germanHolidays(2025, 'DE-BY').map(ymd);
    expect(bayern).toContain('2025-01-06');
    expect(bayern).toContain('2025-06-19');
    expect(bayern).toContain('2025-08-15');
    expect(bayern).toContain('2025-11-01');
  });

  it('Bayern ohne Gemeinde-Feiertag (bavariaAssumption=false): kein 15.08., übrige Landesfeiertage bleiben', () => {
    const mit = germanHolidays(2025, 'DE-BY', true).map(ymd);
    const ohne = germanHolidays(2025, 'DE-BY', false).map(ymd);
    expect(mit).toContain('2025-08-15');
    expect(ohne).not.toContain('2025-08-15');
    expect(ohne).toContain('2025-01-06');
    expect(ohne).toContain('2025-06-19');
    expect(ohne).toContain('2025-11-01');
    expect(ohne.length).toBe(mit.length - 1);
  });

  it('Saarland bleibt unberührt — Mariä Himmelfahrt ist dort landesweit gesetzlich', () => {
    expect(germanHolidays(2025, 'DE-SL', false).map(ymd)).toContain('2025-08-15');
  });

  it('GewSt-VZ-Termin am 15.08.2025 (Fr): mit Gemeinde-Feiertag auf Mo 18.08. verschoben, ohne bleibt Fr', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 11, 31));
    const q3 = (bavariaAssumption: boolean) =>
      generateDeadlines('GEWST_VZ', from, to, false, 'DE-BY', false, bavariaAssumption).find(
        (d) => d.period === '2025-Q3',
      );
    expect(ymd(q3(false)!.dueDate)).toBe('2025-08-15');
    expect(ymd(q3(true)!.dueDate)).toBe('2025-08-18');
  });

  it('Sachsen — Buß- und Bettag fällt auf den letzten Mittwoch vor 23.11.', () => {
    // 2025: 23.11. ist Sonntag. Letzter Mittwoch davor = 19.11.2025.
    const sn = germanHolidays(2025, 'DE-SN').map(ymd);
    expect(sn).toContain('2025-11-19');
    // 2026: 23.11. ist Montag. Letzter Mittwoch davor = 18.11.2026.
    const sn26 = germanHolidays(2026, 'DE-SN').map(ymd);
    expect(sn26).toContain('2026-11-18');
  });

  it('Buß- und Bettag 2022: 23.11. ist selbst Mittwoch → 16.11. (Mittwoch DAVOR)', () => {
    const sn = germanHolidays(2022, 'DE-SN').map(ymd);
    expect(sn).toContain('2022-11-16');
    expect(sn).not.toContain('2022-11-23');
  });

  it('Buß- und Bettag 2033: 23.11. ist selbst Mittwoch → 16.11. (Mittwoch DAVOR)', () => {
    const sn = germanHolidays(2033, 'DE-SN').map(ymd);
    expect(sn).toContain('2033-11-16');
    expect(sn).not.toContain('2033-11-23');
  });

  it('Berlin hat Internationalen Frauentag (8. März)', () => {
    const be = germanHolidays(2025, 'DE-BE').map(ymd);
    expect(be).toContain('2025-03-08');
  });

  it('Brandenburg hat Reformationstag', () => {
    const bb = germanHolidays(2025, 'DE-BB').map(ymd);
    expect(bb).toContain('2025-10-31');
  });
});

describe('shiftToNextWorkday — § 108 (3) AO', () => {
  it('Samstag → Montag', () => {
    // 10.05.2025 ist Samstag → Montag 12.05.
    const r = shiftToNextWorkday(new Date(Date.UTC(2025, 4, 10)));
    expect(ymd(r)).toBe('2025-05-12');
  });

  it('Sonntag → Montag', () => {
    // 10.08.2025 ist Sonntag → Montag 11.08.
    const r = shiftToNextWorkday(new Date(Date.UTC(2025, 7, 10)));
    expect(ymd(r)).toBe('2025-08-11');
  });

  it('Werktag bleibt unverschoben', () => {
    // 10.04.2025 ist Donnerstag, kein Feiertag → bleibt
    const r = shiftToNextWorkday(new Date(Date.UTC(2025, 3, 10)));
    expect(ymd(r)).toBe('2025-04-10');
  });

  it('Tag der Deutschen Einheit (Fr) → Montag', () => {
    // 03.10.2025 ist Freitag und Feiertag → 06.10. Montag
    const r = shiftToNextWorkday(new Date(Date.UTC(2025, 9, 3)));
    expect(ymd(r)).toBe('2025-10-06');
  });

  it('NRW: Allerheiligen-Verschiebung greift in Region NW', () => {
    // 01.11.2025 ist Sa + NRW-Feiertag. Bundesweit: 03.11. Mo
    // NRW: 01.11. ist Feiertag → 03.11. Mo (gleicher Effekt, weil 01.11. = Sa)
    const noRegion = shiftToNextWorkday(new Date(Date.UTC(2025, 10, 1)));
    expect(ymd(noRegion)).toBe('2025-11-03'); // Sa+So überspringen
    const nrw = shiftToNextWorkday(new Date(Date.UTC(2025, 10, 1)), 'DE-NW');
    expect(ymd(nrw)).toBe('2025-11-03');
  });

  it('NRW: Allerheiligen Sa-Fall — 01.11.2025 → 03.11. (überspringt Wochenende und Feiertag)', () => {
    // Hier prüfen wir mit Datum 31.10.2025 (Fr): bundesweit ist das Werktag.
    // In NRW ist 31.10. KEIN Feiertag (das wäre Brandenburg/Sachsen etc.).
    // Aber 01.11. (Sa) wäre Feiertag in NRW.
    const r = shiftToNextWorkday(new Date(Date.UTC(2025, 9, 31)), 'DE-NW');
    expect(ymd(r)).toBe('2025-10-31');
  });

  it('Bayern: 06.01. (Heilige Drei Könige) wird übersprungen', () => {
    // 06.01.2025 ist Montag und in Bayern Feiertag → 07.01. Di
    const r = shiftToNextWorkday(new Date(Date.UTC(2025, 0, 6)), 'DE-BY');
    expect(ymd(r)).toBe('2025-01-07');
    // Ohne Region bleibt 06.01.
    const noRegion = shiftToNextWorkday(new Date(Date.UTC(2025, 0, 6)));
    expect(ymd(noRegion)).toBe('2025-01-06');
  });
});

describe('generateDeadlines — USt-VA monatlich', () => {
  it('Januar-VA fällig 10.02. ohne Dauerfrist', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 1, 28));
    const out = generateDeadlines('USTA_MONATLICH', from, to, false);
    const jan = out.find((d) => d.period === '2025-01');
    expect(jan).toBeDefined();
    expect(ymd(jan!.dueDate)).toBe('2025-02-10');
  });

  it('Januar-VA mit Dauerfrist fällig 10.03. (statt 10.02.)', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 2, 31));
    const out = generateDeadlines('USTA_MONATLICH', from, to, true);
    const jan = out.find((d) => d.period === '2025-01');
    expect(jan).toBeDefined();
    expect(ymd(jan!.dueDate)).toBe('2025-03-10');
  });

  it('Mai-VA 2025 fällig 10.06. ist Werktag', () => {
    // 10.06.2025 ist Dienstag → bleibt
    const from = new Date(Date.UTC(2025, 4, 1));
    const to = new Date(Date.UTC(2025, 6, 31));
    const out = generateDeadlines('USTA_MONATLICH', from, to, false);
    const mai = out.find((d) => d.period === '2025-05');
    expect(ymd(mai!.dueDate)).toBe('2025-06-10');
  });

  it('Verschiebung: Februar-VA 2026 wäre 10.03. — Dienstag (Werktag, keine Verschiebung)', () => {
    const from = new Date(Date.UTC(2026, 1, 1));
    const to = new Date(Date.UTC(2026, 3, 30));
    const out = generateDeadlines('USTA_MONATLICH', from, to, false);
    const feb = out.find((d) => d.period === '2026-02');
    expect(ymd(feb!.dueDate)).toBe('2026-03-10');
  });
});

describe('generateDeadlines — USt-VA quartalsweise', () => {
  it('Q1 fällig 10.04.', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 4, 30));
    const out = generateDeadlines('USTA_QUARTAL', from, to, false);
    const q1 = out.find((d) => d.period === '2025-Q1');
    expect(q1).toBeDefined();
    expect(ymd(q1!.dueDate)).toBe('2025-04-10');
  });

  it('Q1 mit Dauerfrist → 12.05. (10.05. ist Samstag, Verschiebung)', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 5, 30));
    const out = generateDeadlines('USTA_QUARTAL', from, to, true);
    const q1 = out.find((d) => d.period === '2025-Q1');
    // 10.05.2025 ist Samstag → Mo 12.05.
    expect(ymd(q1!.dueDate)).toBe('2025-05-12');
  });
});

describe('generateDeadlines — Vorauszahlungs-Termine', () => {
  it('ESt-VZ Q1 fällig 10.03.', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 3, 30));
    const out = generateDeadlines('EST_VZ', from, to, false);
    const q1 = out.find((d) => d.period === '2025-Q1');
    expect(q1).toBeDefined();
    expect(ymd(q1!.dueDate)).toBe('2025-03-10');
  });

  it('ESt-VZ erzeugt 4 Termine im Jahr', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 11, 31));
    const out = generateDeadlines('EST_VZ', from, to, false);
    const yearOnes = out.filter((d) => d.period.startsWith('2025-'));
    expect(yearOnes.length).toBe(4);
    expect(yearOnes.map((d) => d.period).sort()).toEqual([
      '2025-Q1',
      '2025-Q2',
      '2025-Q3',
      '2025-Q4',
    ]);
  });

  it('GewSt-VZ 2025 — § 19 (1) GewStG: 15.02./15.05./15.08./15.11. (nicht 10er)', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 11, 31));
    const out = generateDeadlines('GEWST_VZ', from, to, false);
    const q = Object.fromEntries(
      out.filter((d) => d.period.startsWith('2025-')).map((d) => [d.period, ymd(d.dueDate)]),
    );
    // 15.02.2025 = Sa → Mo 17.02.; 15.05. = Do; 15.08. = Fr; 15.11.2025 = Sa → Mo 17.11.
    expect(q['2025-Q1']).toBe('2025-02-17');
    expect(q['2025-Q2']).toBe('2025-05-15');
    expect(q['2025-Q3']).toBe('2025-08-15');
    expect(q['2025-Q4']).toBe('2025-11-17');
  });
});

describe('generateDeadlines — LSt-Jahresanmeldung', () => {
  it('LStA jährlich 2025 — § 41a (1) EStG: 10.01.2026 (Sa) → Mo 12.01.2026', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 11, 31));
    const out = generateDeadlines('LSTA_JAEHRLICH', from, to, false);
    const hit = out.find((d) => d.period === '2025');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2026-01-12');
  });

  it('LStA jährlich ignoriert advised (§ 149 (3) AO gilt nicht für Anmeldungen)', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 11, 31));
    const plain = generateDeadlines('LSTA_JAEHRLICH', from, to, false);
    const advised = generateDeadlines('LSTA_JAEHRLICH', from, to, false, null, true);
    expect(advised.map((d) => [d.period, ymd(d.dueDate)])).toEqual(
      plain.map((d) => [d.period, ymd(d.dueDate)]),
    );
  });
});

describe('generateDeadlines — Erklärungen', () => {
  it('ESt-Erklärung VZ 2024 fällig 31.07.2025 ist Donnerstag', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 11, 31));
    const out = generateDeadlines('EST_ERKLAERUNG', from, to, false);
    // Periode = year - 1 = "2024"
    const hit = out.find((d) => d.period === '2024');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2025-07-31');
  });

  it('USt-Jahreserklärung VZ 2025 fällig 31.07.2026 ist Freitag', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 11, 31));
    const out = generateDeadlines('USTA_JAEHRLICH', from, to, false);
    const hit = out.find((d) => d.period === '2025');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2026-07-31');
  });
});

describe('generateDeadlines — Region', () => {
  it('NRW: Mai-VA 2025 fällig 10.06. (Di, kein NRW-Feiertag) — bleibt unverschoben', () => {
    const from = new Date(Date.UTC(2025, 4, 1));
    const to = new Date(Date.UTC(2025, 6, 31));
    const out = generateDeadlines('USTA_MONATLICH', from, to, false, 'DE-NW');
    const mai = out.find((d) => d.period === '2025-05');
    expect(ymd(mai!.dueDate)).toBe('2025-06-10');
  });

  it('Bayern: Dezember-VA 2024 mit Dauerfrist → 10.02.2025 (Mo, frei)', () => {
    // Berichtsmonat Dezember 2024, Dauerfrist +2 Monate → 10.02.2025
    // 10.02.2025 ist Montag → bleibt
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 1, 28));
    const out = generateDeadlines('USTA_MONATLICH', from, to, true, 'DE-BY');
    const dez = out.find((d) => d.period === '2024-12');
    expect(dez).toBeDefined();
    expect(ymd(dez!.dueDate)).toBe('2025-02-10');
  });
});

describe('generateDeadlines — Bereichs-Invariante [from, to]', () => {
  const ALL_KINDS = Object.keys(SCHEDULE_LABELS) as (keyof typeof SCHEDULE_LABELS)[];

  it('ALLE Ergebnisse liegen in [from, to] — über Arten, Dauerfrist, advised und Regionen', () => {
    const ranges: Array<[Date, Date]> = [
      [new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 2, 31))], // 90-Tage-Horizont
      [new Date(Date.UTC(2025, 5, 15)), new Date(Date.UTC(2025, 8, 13))], // mitten im Jahr
      [new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 11, 31))], // zwei Jahre
      [new Date(Date.UTC(2027, 11, 20)), new Date(Date.UTC(2028, 0, 5))], // kurz, Jahreswechsel
    ];
    for (const kind of ALL_KINDS) {
      for (const [from, to] of ranges) {
        for (const dauerfrist of [false, true]) {
          for (const advised of [false, true]) {
            for (const region of [null, 'DE-BY', 'DE-SN'] as const) {
              const out = generateDeadlines(kind, from, to, dauerfrist, region, advised);
              for (const d of out) {
                const label = `${kind} ${d.period} → ${ymd(d.dueDate)} außerhalb [${ymd(from)}, ${ymd(to)}]`;
                expect(d.dueDate.getTime(), label).toBeGreaterThanOrEqual(from.getTime());
                expect(d.dueDate.getTime(), label).toBeLessThanOrEqual(to.getTime());
              }
            }
          }
        }
      }
    }
  });

  it('QUARTAL: 90-Tage-Horizont erzeugt keine Termine über den Horizont hinaus (Regression)', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 2, 31));
    const out = generateDeadlines('USTA_QUARTAL', from, to, false);
    // Nur Q4/2025 (fällig 10.01.2026, Sa → Mo 12.01.) liegt im Fenster —
    // vorher wurden ALLE Quartale von 2025 bis 2027 erzeugt.
    expect(out.map((d) => d.period)).toEqual(['2025-Q4']);
    expect(ymd(out[0]!.dueDate)).toBe('2026-01-12');
  });

  it('MONATLICH: nur Fälligkeiten im Fenster (Regression)', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 1, 28));
    const out = generateDeadlines('USTA_MONATLICH', from, to, false);
    // Dez-2025-VA fällig 12.01.2026 (10.01. ist Sa), Jan-2026-VA fällig 10.02.2026.
    expect(out.map((d) => d.period).sort()).toEqual(['2025-12', '2026-01']);
  });
});

describe('generateDeadlines — beratene Erklärungsfrist (§ 149 (3) AO)', () => {
  it('VZ 2025 beraten → letzter Februartag 2027 ist So, 28.02. → Verschiebung auf Mo, 01.03.2027 (§ 108 (3) AO)', () => {
    const from = new Date(Date.UTC(2027, 0, 1));
    const to = new Date(Date.UTC(2027, 11, 31));
    const out = generateDeadlines('EST_ERKLAERUNG', from, to, false, null, true);
    const hit = out.find((d) => d.period === '2025');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2027-03-01');
  });

  it('Schaltjahr: VZ 2026 beraten → 29.02.2028 (Di, Werktag — keine Verschiebung)', () => {
    const from = new Date(Date.UTC(2028, 0, 1));
    const to = new Date(Date.UTC(2028, 11, 31));
    const out = generateDeadlines('KST_ERKLAERUNG', from, to, false, null, true);
    const hit = out.find((d) => d.period === '2026');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2028-02-29');
  });

  it('Default (advised=false) bleibt 31.07. des Folgejahres — bestehende Termine ändern sich nicht', () => {
    const from = new Date(Date.UTC(2027, 0, 1));
    const to = new Date(Date.UTC(2027, 11, 31));
    const out = generateDeadlines('EST_ERKLAERUNG', from, to, false);
    const hit = out.find((d) => d.period === '2026');
    expect(hit).toBeDefined();
    // 31.07.2027 ist Samstag → Verschiebung auf Mo, 02.08.2027
    expect(ymd(hit!.dueDate)).toBe('2027-08-02');
  });
});

describe('generateDeadlines — EGAO-Übergangsfristen (Art. 97 § 36 Abs. 3 EGAO)', () => {
  it('VZ 2023 beraten → 31.05.2025 (Sa) → Mo 02.06.2025 (nicht Ende Februar 2025)', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 11, 31));
    const out = generateDeadlines('EST_ERKLAERUNG', from, to, false, null, true);
    const hit = out.find((d) => d.period === '2023');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2025-06-02');
  });

  it('VZ 2024 beraten → 30.04.2026 (Do, Werktag — letzte EGAO-Verlängerung)', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 11, 31));
    const out = generateDeadlines('KST_ERKLAERUNG', from, to, false, null, true);
    const hit = out.find((d) => d.period === '2024');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2026-04-30');
  });

  it('VZ 2023 nicht beraten → 31.08.2024 (Sa) → Mo 02.09.2024', () => {
    const from = new Date(Date.UTC(2024, 0, 1));
    const to = new Date(Date.UTC(2024, 11, 31));
    const out = generateDeadlines('EST_ERKLAERUNG', from, to, false);
    const hit = out.find((d) => d.period === '2023');
    expect(hit).toBeDefined();
    expect(ymd(hit!.dueDate)).toBe('2024-09-02');
  });

  it('VZ 2020 nicht beraten → 31.10.2021 (So): bundesweit Mo 01.11., in Bayern (Allerheiligen) Di 02.11.2021', () => {
    const from = new Date(Date.UTC(2021, 0, 1));
    const to = new Date(Date.UTC(2021, 11, 31));
    const bund = generateDeadlines('EST_ERKLAERUNG', from, to, false);
    expect(ymd(bund.find((d) => d.period === '2020')!.dueDate)).toBe('2021-11-01');
    const by = generateDeadlines('EST_ERKLAERUNG', from, to, false, 'DE-BY');
    expect(ymd(by.find((d) => d.period === '2020')!.dueDate)).toBe('2021-11-02');
  });

  it('VZ 2024 nicht beraten → Regelfrist 31.07.2025 (EGAO endet nicht beraten mit VZ 2023)', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 11, 31));
    const out = generateDeadlines('EST_ERKLAERUNG', from, to, false);
    expect(ymd(out.find((d) => d.period === '2024')!.dueDate)).toBe('2025-07-31');
  });

  it('VZ 2025 beraten → Regelfrist § 149 (3) AO (EGAO endet beraten mit VZ 2024)', () => {
    const from = new Date(Date.UTC(2027, 0, 1));
    const to = new Date(Date.UTC(2027, 11, 31));
    const out = generateDeadlines('USTA_JAEHRLICH', from, to, false, null, true);
    // 28.02.2027 (So) → Mo 01.03.2027
    expect(ymd(out.find((d) => d.period === '2025')!.dueDate)).toBe('2027-03-01');
  });
});

describe('endOfDueDay / berlinCalendarDate / startOfUtcDay — § 108 (1) AO Tagesgrenzen', () => {
  it('endOfDueDay liefert das Ende des Fälligkeitstags in Europe/Berlin', () => {
    const r = endOfDueDay(new Date(Date.UTC(2026, 2, 10)));
    expect(r.toISOString()).toBe('2026-03-10T22:59:59.999Z');
    const summer = endOfDueDay(new Date(Date.UTC(2026, 6, 10)));
    expect(summer.toISOString()).toBe('2026-07-10T21:59:59.999Z');
  });

  it('berlinCalendarDate kippt an der UTC-/Berlin-Tagesgrenze korrekt', () => {
    expect(berlinCalendarDate(new Date('2026-07-01T21:59:59.999Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(berlinCalendarDate(new Date('2026-07-01T22:00:00.000Z')).toISOString()).toBe(
      '2026-07-02T00:00:00.000Z',
    );
  });

  it.each([
    ['CET', '2026-01-15T22:59:59.999Z', '2026-01-15T00:00:00.000Z'],
    ['CET', '2026-01-15T23:00:00.000Z', '2026-01-16T00:00:00.000Z'],
    ['CEST', '2026-07-15T21:59:59.999Z', '2026-07-15T00:00:00.000Z'],
    ['CEST', '2026-07-15T22:00:00.000Z', '2026-07-16T00:00:00.000Z'],
  ])(
    'berlinTodayUtcMidnight bildet die %s-Tagesgrenze als @db.Date ab',
    (_zone, instant, expected) => {
      const result = berlinTodayUtcMidnight(new Date(instant));
      expect(result.toISOString()).toBe(expected);
      expect(result.getUTCHours()).toBe(0);
    },
  );

  it.each([
    ['Beginn der Sommerzeit', '2026-03-29T21:59:59.999Z', '2026-03-29T00:00:00.000Z'],
    ['Beginn der Sommerzeit', '2026-03-29T22:00:00.000Z', '2026-03-30T00:00:00.000Z'],
    ['Ende der Sommerzeit', '2026-10-25T22:59:59.999Z', '2026-10-25T00:00:00.000Z'],
    ['Ende der Sommerzeit', '2026-10-25T23:00:00.000Z', '2026-10-26T00:00:00.000Z'],
  ])('bleibt am %s DST-sicher', (_transition, instant, expected) => {
    expect(berlinTodayUtcMidnight(new Date(instant)).toISOString()).toBe(expected);
  });

  it('heute fälliger Termin ist bis Tagesende NICHT abgelaufen', () => {
    const due = new Date(Date.UTC(2026, 2, 10)); // UTC-Mitternacht (@db.Date)
    const mittags = new Date(Date.UTC(2026, 2, 10, 12, 30));
    expect(endOfDueDay(due).getTime()).toBeGreaterThanOrEqual(mittags.getTime());
    const morgenFrueh = new Date(Date.UTC(2026, 2, 11, 0, 30));
    expect(endOfDueDay(due).getTime()).toBeLessThan(morgenFrueh.getTime());
  });

  it('startOfUtcDay schneidet auf UTC-Mitternacht — Termine von HEUTE sind nicht überfällig', () => {
    const now = new Date(Date.UTC(2026, 2, 10, 15, 23, 42));
    const cutoff = startOfUtcDay(now);
    expect(cutoff.toISOString()).toBe('2026-03-10T00:00:00.000Z');
    // Heute fälliger Termin (UTC-Mitternacht) liegt NICHT vor dem Cutoff …
    expect(new Date(Date.UTC(2026, 2, 10)).getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    // … der von gestern schon.
    expect(new Date(Date.UTC(2026, 2, 9)).getTime()).toBeLessThan(cutoff.getTime());
  });
});
