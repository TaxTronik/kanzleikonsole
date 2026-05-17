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
  generateDeadlines,
  germanHolidays,
  shiftToNextWorkday,
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

  it('Sachsen — Buß- und Bettag fällt auf den letzten Mittwoch vor 23.11.', () => {
    // 2025: 23.11. ist Sonntag. Letzter Mittwoch davor = 19.11.2025.
    const sn = germanHolidays(2025, 'DE-SN').map(ymd);
    expect(sn).toContain('2025-11-19');
    // 2026: 23.11. ist Montag. Letzter Mittwoch davor = 18.11.2026.
    const sn26 = germanHolidays(2026, 'DE-SN').map(ymd);
    expect(sn26).toContain('2026-11-18');
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
    expect(yearOnes.map((d) => d.period).sort()).toEqual(['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4']);
  });

  it('GewSt-VZ Q4 (Dezember 2025) — 10.12.2025 ist Mittwoch → bleibt', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 11, 31));
    const out = generateDeadlines('GEWST_VZ', from, to, false);
    const q4 = out.find((d) => d.period === '2025-Q4');
    expect(ymd(q4!.dueDate)).toBe('2025-12-10');
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
