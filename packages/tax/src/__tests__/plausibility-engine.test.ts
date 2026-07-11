// =============================================================================
// Plausibilitäts-Golden-Tests (fachlicher Audit) — gesetzlich fixierte
// Erwartungswerte gegen deutsches Steuerrecht.
//
// Jeder Test dokumentiert die Rechtsgrundlage im Kommentar. Diese Tests
// SOLLEN brechen, wenn jemand die fachlichen Konstanten der Engine ändert.
//
// Abgedeckt:
//   - Gauß-Osterformel an bekannten Randterminen (2024 früh, 2038 spätest-
//     möglicher Randbereich 25.04.)
//   - Exklusivität der Landesfeiertage (Buß- und Bettag NUR Sachsen,
//     Weltkindertag NUR Thüringen, Frauentag NUR Berlin + MV,
//     Fronleichnam exakt BW/BY/HE/NW/RP/SL — Feiertagsgesetze der Länder)
//   - § 108 (3) AO Verschiebung über einen LANDES-Feiertag
//     (Mariä Himmelfahrt 15.08. = GewSt-VZ-Q3-Termin in BY/SL)
//   - Dauerfristverlängerung (§§ 46-48 UStDV) wirkt NICHT auf
//     Vorauszahlungen (§ 37 EStG, § 19 GewStG) und NICHT auf die
//     USt-Jahreserklärung (§ 18 (3) UStG / § 149 AO)
//   - § 19 (1) GewStG Quartals-Zuordnung 15.02.→Q1 … 15.11.→Q4
//   - § 41a (1) EStG LSt-Anmeldung monatlich: 10. des Folgemonats
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  generateDeadlines,
  germanHolidays,
  shiftToNextWorkday,
  appealDeadline,
  appealDeadlineFromNotification,
  appealDeadlineForPostAbroad,
  klageDeadline,
  bekanntgabeFiktionTage,
  type GermanRegion,
} from '../index';

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function utc(s: string): Date {
  return new Date(s + 'T00:00:00.000Z');
}

const ALL_REGIONS: GermanRegion[] = [
  'DE-BW',
  'DE-BY',
  'DE-BE',
  'DE-BB',
  'DE-HB',
  'DE-HH',
  'DE-HE',
  'DE-MV',
  'DE-NI',
  'DE-NW',
  'DE-RP',
  'DE-SL',
  'DE-SN',
  'DE-ST',
  'DE-SH',
  'DE-TH',
];

describe('Gauß-Osterformel — bekannte Ostertermine (Golden)', () => {
  // Referenz: gregorianischer Osterkalender (astronomische Ostertafeln).
  it('Ostern 2024 = 31.03. → Karfreitag 29.03., Ostermontag 01.04.', () => {
    const out = germanHolidays(2024, null).map(ymd);
    expect(out).toContain('2024-03-29');
    expect(out).toContain('2024-04-01');
  });

  it('Ostern 2025 = 20.04. → Karfreitag 18.04., Ostermontag 21.04.', () => {
    const out = germanHolidays(2025, null).map(ymd);
    expect(out).toContain('2025-04-18');
    expect(out).toContain('2025-04-21');
  });

  it('Ostern 2038 = 25.04. (spätester Ostertermin des Jahrhunderts) → Karfreitag 23.04., Ostermontag 26.04.', () => {
    const out = germanHolidays(2038, null).map(ymd);
    expect(out).toContain('2038-04-23');
    expect(out).toContain('2038-04-26');
  });

  it('abgeleitete bewegliche Feiertage 2026: Himmelfahrt 14.05. (Ostern+39), Pfingstmontag 25.05. (Ostern+50)', () => {
    // Ostern 2026 = 05.04.
    const out = germanHolidays(2026, null).map(ymd);
    expect(out).toContain('2026-05-14');
    expect(out).toContain('2026-05-25');
  });
});

describe('Landesfeiertage — Exklusivität (Feiertagsgesetze der Länder)', () => {
  it('Buß- und Bettag ist NUR in Sachsen gesetzlicher Feiertag (§ 1 SächsSFG)', () => {
    // 2025: Mittwoch vor dem 23.11. = 19.11.2025
    for (const region of ALL_REGIONS) {
      const has = germanHolidays(2025, region).map(ymd).includes('2025-11-19');
      expect(has, `Buß- und Bettag in ${region}`).toBe(region === 'DE-SN');
    }
  });

  it('Weltkindertag (20.09.) ist NUR in Thüringen Feiertag (§ 2 ThürFtG, seit 2019)', () => {
    for (const region of ALL_REGIONS) {
      const has = germanHolidays(2025, region).map(ymd).includes('2025-09-20');
      expect(has, `Weltkindertag in ${region}`).toBe(region === 'DE-TH');
    }
  });

  it('Internationaler Frauentag (08.03.) ist NUR in Berlin und MV Feiertag', () => {
    for (const region of ALL_REGIONS) {
      const has = germanHolidays(2025, region).map(ymd).includes('2025-03-08');
      expect(has, `Frauentag in ${region}`).toBe(region === 'DE-BE' || region === 'DE-MV');
    }
  });

  it('Fronleichnam gilt exakt in BW, BY, HE, NW, RP, SL', () => {
    // Fronleichnam 2025 = Ostersonntag (20.04.) + 60 Tage = 19.06.2025
    const expected = new Set(['DE-BW', 'DE-BY', 'DE-HE', 'DE-NW', 'DE-RP', 'DE-SL']);
    for (const region of ALL_REGIONS) {
      const has = germanHolidays(2025, region).map(ymd).includes('2025-06-19');
      expect(has, `Fronleichnam in ${region}`).toBe(expected.has(region));
    }
  });

  it('Reformationstag (31.10.) gilt exakt in BB, HB, HH, MV, NI, SN, ST, SH, TH', () => {
    const expected = new Set([
      'DE-BB',
      'DE-HB',
      'DE-HH',
      'DE-MV',
      'DE-NI',
      'DE-SN',
      'DE-ST',
      'DE-SH',
      'DE-TH',
    ]);
    for (const region of ALL_REGIONS) {
      const has = germanHolidays(2025, region).map(ymd).includes('2025-10-31');
      expect(has, `Reformationstag in ${region}`).toBe(expected.has(region));
    }
  });
});

describe('§ 108 (3) AO — Verschiebung über Landesfeiertag am Fälligkeitstag', () => {
  it('GewSt-VZ Q3 2025 (15.08., Freitag): in Bayern/Saarland Mariä Himmelfahrt → Mo 18.08.; bundesweit bleibt 15.08.', () => {
    const from = new Date(Date.UTC(2025, 6, 1));
    const to = new Date(Date.UTC(2025, 8, 30));
    const plain = generateDeadlines('GEWST_VZ', from, to, false, null);
    const bayern = generateDeadlines('GEWST_VZ', from, to, false, 'DE-BY');
    const saarland = generateDeadlines('GEWST_VZ', from, to, false, 'DE-SL');
    expect(ymd(plain.find((d) => d.period === '2025-Q3')!.dueDate)).toBe('2025-08-15');
    expect(ymd(bayern.find((d) => d.period === '2025-Q3')!.dueDate)).toBe('2025-08-18');
    expect(ymd(saarland.find((d) => d.period === '2025-Q3')!.dueDate)).toBe('2025-08-18');
  });

  it('shiftToNextWorkday überspringt Kettenlagen: Karfreitag 03.04.2026 → nach Ostermontag (Di 07.04.2026)', () => {
    // 03.04.2026 (Karfreitag) → Sa/So → Ostermontag 06.04. → Di 07.04.
    const r = shiftToNextWorkday(new Date(Date.UTC(2026, 3, 3)));
    expect(ymd(r)).toBe('2026-04-07');
  });
});

describe('Dauerfristverlängerung (§§ 46-48 UStDV) — Geltungsbereich', () => {
  // Die Dauerfristverlängerung existiert NUR für USt-VORANMELDUNGEN.
  // Vorauszahlungstermine (§ 37 (1) EStG, § 19 (1) GewStG) und die
  // USt-Jahreserklärung (§ 18 (3) UStG i. V. m. § 149 AO) kennen keine
  // Dauerfrist — das Flag darf dort keinerlei Wirkung haben.
  const from = new Date(Date.UTC(2025, 0, 1));
  const to = new Date(Date.UTC(2026, 11, 31));

  for (const kind of ['EST_VZ', 'KST_VZ', 'GEWST_VZ', 'USTA_JAEHRLICH'] as const) {
    it(`${kind}: hasDauerfrist=true ändert keine Termine`, () => {
      const plain = generateDeadlines(kind, from, to, false);
      const withDauer = generateDeadlines(kind, from, to, true);
      expect(withDauer.map((d) => [d.period, ymd(d.dueDate)])).toEqual(
        plain.map((d) => [d.period, ymd(d.dueDate)]),
      );
    });
  }
});

describe('§ 19 (1) GewStG — Quartals-Zuordnung der GewSt-VZ 2026', () => {
  it('15.02.→Q1 (So→Mo 16.02.), 15.05.→Q2 (Fr), 15.08.→Q3 (Sa→Mo 17.08.), 15.11.→Q4 (So→Mo 16.11.)', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 11, 31));
    const out = generateDeadlines('GEWST_VZ', from, to, false);
    const q = Object.fromEntries(
      out.filter((d) => d.period.startsWith('2026-')).map((d) => [d.period, ymd(d.dueDate)]),
    );
    expect(q).toEqual({
      '2026-Q1': '2026-02-16',
      '2026-Q2': '2026-05-15',
      '2026-Q3': '2026-08-17',
      '2026-Q4': '2026-11-16',
    });
  });
});

describe('§ 41a (1) EStG — LSt-Anmeldung monatlich: 10. Tag nach Ablauf des Anmeldungszeitraums', () => {
  it('Januar-Anmeldung 2025 fällig 10.02.2025 (Mo, Werktag)', () => {
    const from = new Date(Date.UTC(2025, 0, 1));
    const to = new Date(Date.UTC(2025, 2, 31));
    const out = generateDeadlines('LSTA_MONATLICH', from, to, false);
    const jan = out.find((d) => d.period === '2025-01');
    expect(jan).toBeDefined();
    expect(ymd(jan!.dueDate)).toBe('2025-02-10');
  });

  it('Dezember-Anmeldung 2026 fällig 10.01.2027 (So) → Mo 11.01.2027 (§ 108 (3) AO)', () => {
    const from = new Date(Date.UTC(2027, 0, 1));
    const to = new Date(Date.UTC(2027, 1, 28));
    const out = generateDeadlines('LSTA_MONATLICH', from, to, false);
    const dez = out.find((d) => d.period === '2026-12');
    expect(dez).toBeDefined();
    expect(ymd(dez!.dueDate)).toBe('2027-01-11');
  });
});

describe('§ 18 (1)/(2) UStG — USt-VA Q4 über den Jahreswechsel', () => {
  it('Q4/2026 fällig 11.01.2027 (10.01. = So); mit Dauerfrist 10.02.2027 (Mi)', () => {
    const from = new Date(Date.UTC(2027, 0, 1));
    const to = new Date(Date.UTC(2027, 2, 31));
    const plain = generateDeadlines('USTA_QUARTAL', from, to, false);
    const dauer = generateDeadlines('USTA_QUARTAL', from, to, true);
    expect(ymd(plain.find((d) => d.period === '2026-Q4')!.dueDate)).toBe('2027-01-11');
    expect(ymd(dauer.find((d) => d.period === '2026-Q4')!.dueDate)).toBe('2027-02-10');
  });
});

describe('Einspruchsfrist § 355 AO + Bekanntgabefiktionen §§ 122, 122a AO', () => {
  it('Regelfall: +4 Tage Bekanntgabefiktion, dann kalendarischer Monat', () => {
    // Bescheid 01.02.2027 (Mo) → Fiktion 05.02.2027 (Fr) → +1 Monat 05.03.2027 (Fr).
    // Der frühere „+33 Tage"-Code hätte 06.03.2027 gezeigt — einen Tag zu spät.
    expect(ymd(appealDeadline(utc('2027-02-01')))).toBe('2027-03-05');
  });

  it('4-Tage-Fiktion (§ 122 (2) Nr. 1 AO ab 2025), nicht 3', () => {
    // Bescheid 12.01.2026 (Mo): +4 = 16.01.2026 (Fr) → +1 Monat 16.02.2026 (Mo).
    // Mit alter 3-Tage-Fiktion wäre die Bekanntgabe der 15.01. (Do) gewesen.
    expect(ymd(appealDeadline(utc('2026-01-12')))).toBe('2026-02-16');
  });

  it('Bekanntgabetag auf Sonntag → nächster Werktag (§ 108 (3) AO)', () => {
    // Bescheid 01.07.2026 (Mi): +4 = 05.07.2026 (So) → Bekanntgabe 06.07.2026 (Mo)
    // → +1 Monat 06.08.2026 (Do).
    expect(ymd(appealDeadline(utc('2026-07-01')))).toBe('2026-08-06');
  });

  it('Monatsende-Überlauf im Schaltjahr (§ 188 (3) BGB): 31.01. → 29.02.', () => {
    // Bescheid 27.01.2028 (Mi): +4 = 31.01.2028 (Mo, Werktag) → Bekanntgabe.
    // +1 Monat: 31.02. existiert nicht → letzter Februartag 2028 (Schaltjahr) =
    // 29.02.2028 (Di, Werktag).
    expect(ymd(appealDeadline(utc('2028-01-27')))).toBe('2028-02-29');
  });

  it('Fristende über Weihnachts-Feiertagskette → nächster Werktag', () => {
    // Bescheid 21.11.2026 (Sa): +4 = 25.11.2026 (Mi) → Bekanntgabe.
    // +1 Monat: 25.12.2026 (1. Weihnachtstag, Fr) → 26.12. (2. Weihnachtstag, Sa)
    // → 27.12. (So) → Fristende Mo 28.12.2026.
    expect(ymd(appealDeadline(utc('2026-11-21')))).toBe('2026-12-28');
  });

  // § 122 (2) AO Halbsatz 2: Fiktion gilt NICHT bei späterem tatsächlichem Zugang.
  it('tatsächlicher Zugang NACH Fiktionstag → Monatsfrist ab echtem Zugang', () => {
    // Bescheid 01.02.2027 (Mo): Fiktion 05.02.2027 (Fr). Tatsächlich erst
    // 09.02.2027 (Di) zugegangen → Fristende 09.03.2027 (Di).
    // Ohne receivedAt wäre es der 05.03.2027.
    expect(ymd(appealDeadline(utc('2027-02-01'), null, utc('2027-02-09')))).toBe('2027-03-09');
  });

  it('tatsächlicher Zugang VOR Fiktionstag verkürzt die Frist NICHT', () => {
    // Bescheid 01.02.2027: Fiktion 05.02.2027 (Fr). Tatsächlich schon am
    // 03.02.2027 (Mi) im Briefkasten → Fiktion bleibt maßgeblich (Mindestschutz)
    // → Fristende 05.03.2027, wie ohne receivedAt.
    expect(ymd(appealDeadline(utc('2027-02-01'), null, utc('2027-02-03')))).toBe('2027-03-05');
  });

  it('tatsächlicher Zugang am Samstag wird NICHT werktagsverschoben', () => {
    // Bescheid 01.07.2026 (Mi): Fiktion 05.07. (So) → verschoben Mo 06.07.
    // Tatsächlich erst Sa 11.07.2026 zugegangen (Faktum, keine Verschiebung)
    // → +1 Monat = 11.08.2026 (Di) = Fristende.
    expect(ymd(appealDeadline(utc('2026-07-01'), null, utc('2026-07-11')))).toBe('2026-08-11');
  });

  // Art. 97 § 1 Abs. 16 EGAO: Die Vier-Tages-Fiktion des PostModG gilt erst
  // für Verwaltungsakte, die ab dem 01.01.2025 zur Post gegeben wurden.
  it('Alt-Bescheid (Aufgabe bis 31.12.2024): DREI-Tages-Fiktion (§ 122 (2) AO a.F.)', () => {
    // Bescheid 10.12.2024 (Di): +3 = 13.12.2024 (Fr, Werktag) → Bekanntgabe.
    // +1 Monat = 13.01.2025 (Mo) = Fristende. Mit (falscher) 4-Tage-Fiktion
    // wäre der 14.12. (Sa) → Mo 16.12. → Fristende 16.01.2025 — drei Tage zu spät.
    expect(ymd(appealDeadline(utc('2024-12-10')))).toBe('2025-01-13');
  });

  it('bekanntgabeFiktionTage — Stichtagsgrenze 01.01.2025', () => {
    expect(bekanntgabeFiktionTage(utc('2024-12-31'))).toBe(3);
    expect(bekanntgabeFiktionTage(utc('2025-01-01'))).toBe(4);
  });

  it('förmliche/persönliche Bekanntgabe: keine Fiktion aufschlagen', () => {
    expect(ymd(appealDeadlineFromNotification(utc('2026-07-07')))).toBe('2026-08-07');
  });

  it('Auslandspost: ein Monat Bekanntgabefiktion plus ein Monat Einspruchsfrist', () => {
    expect(ymd(appealDeadlineForPostAbroad(utc('2026-01-10')))).toBe('2026-03-10');
    expect(ymd(appealDeadlineForPostAbroad(utc('2026-01-10'), null, utc('2026-03-01')))).toBe(
      '2026-04-01',
    );
  });

  it('fehlende oder unrichtige Rechtsbehelfsbelehrung → Jahresfrist (§ 356 Abs. 2 AO)', () => {
    expect(ymd(appealDeadlineFromNotification(utc('2026-07-07'), null, false))).toBe('2027-07-07');
    // 29.02.2028 + ein Jahr → 28.02.2029; Mittwoch, keine Verschiebung.
    expect(ymd(appealDeadlineFromNotification(utc('2028-02-29'), null, false))).toBe('2029-02-28');
  });
});

describe('Klagefrist § 47 (1) FGO ab Bekanntgabe der Einspruchsentscheidung', () => {
  it('schlägt KEINE Bekanntgabefiktion auf (Argument ist bereits die Bekanntgabe)', () => {
    // Bekanntgabe 07.07.2026 (Di) → +1 Monat 07.08.2026 (Fr), OHNE +4-Tage-
    // Fiktion. appealDeadline auf denselben Tag ergäbe dagegen 13.08.2026
    // (Fiktion 11.07. → +1 Monat) — die Klagefrist wäre knapp eine Woche zu spät.
    expect(ymd(klageDeadline(utc('2026-07-07')))).toBe('2026-08-07');
    expect(ymd(appealDeadline(utc('2026-07-07')))).toBe('2026-08-13');
  });

  it('Fristende-Werktagsverschiebung (§ 108 (3) AO)', () => {
    // Bekanntgabe 30.06.2026 (Di) → +1 Monat 30.07.2026 (Do, Werktag).
    expect(ymd(klageDeadline(utc('2026-06-30')))).toBe('2026-07-30');
    // Bekanntgabe 05.01.2026 (Mo) → +1 Monat 05.02.2026 (Do, Werktag).
    expect(ymd(klageDeadline(utc('2026-01-05')))).toBe('2026-02-05');
  });

  it('fehlende/unrichtige Klagebelehrung → Jahresfrist (§ 55 Abs. 2 FGO)', () => {
    expect(ymd(klageDeadline(utc('2026-07-07'), null, false))).toBe('2027-07-07');
  });

  it('Monatsende-Überlauf: 31.01. → 28.02. (Nicht-Schaltjahr)', () => {
    // Bekanntgabe 31.01.2026 (Sa) → +1 Monat: 31.02. existiert nicht →
    // 28.02.2026 (Sa) → § 108 (3)-Verschiebung auf Mo 02.03.2026.
    expect(ymd(klageDeadline(utc('2026-01-31')))).toBe('2026-03-02');
  });

  it('normalisiert eine Nicht-Mitternacht-Zeit auf den UTC-Tag', () => {
    // 14:30 UTC am 07.07.2026 → derselbe Fristbeginn wie Mitternacht.
    expect(ymd(klageDeadline(new Date('2026-07-07T14:30:00Z')))).toBe('2026-08-07');
  });
});
