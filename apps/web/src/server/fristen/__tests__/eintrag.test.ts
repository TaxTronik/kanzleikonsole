import { describe, it, expect } from 'vitest';

// Fachkatalog: TAX-CONTROL-STATUS-001
import {
  taxDeadlineErledigt,
  taxNoticeFristErledigt,
  taxNoticeKlageFristErledigt,
  requestErledigt,
  bucketFor,
  sortEintraege,
  begruendungTragfaehig,
  RAND_LEERRAUM_CODEPOINTS,
  type FristEintrag,
} from '../eintrag';

// Status-Wahrheitstabellen des Fristenkontrollbuchs — eine falsche Zuordnung
// hieße: eine offene Frist erscheint als erledigt (Haftungsrisiko) oder
// umgekehrt (Rauschen).
describe('Erledigt-Wahrheitstabellen', () => {
  it('Steuertermin: DONE braucht Zeit und Person; SKIPPED bleibt ohne Grund offen', () => {
    expect(taxDeadlineErledigt('DONE')).toBe(false);
    expect(taxDeadlineErledigt('DONE', new Date('2026-06-01'), 'staff-1')).toBe(true);
    expect(taxDeadlineErledigt('SKIPPED')).toBe(false);
    for (const offen of ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'SUBMITTED', 'OVERDUE']) {
      expect(taxDeadlineErledigt(offen), offen).toBe(false);
    }
  });

  it('Einspruchsfrist: Status allein schließt nicht; Einlegung oder Disposition braucht Nachweis', () => {
    expect(taxNoticeFristErledigt('NEU')).toBe(false);
    expect(taxNoticeFristErledigt('GEPRUEFT')).toBe(false);
    for (const status of [
      'EINSPRUCH',
      'ABGEHOLFEN',
      'TEILABHILFE',
      'TEILEINSPRUCHSENTSCHEIDUNG',
      'ZURUECKGEWIESEN',
      'KLAGE',
      'BESTANDSKRAEFTIG',
    ]) {
      expect(taxNoticeFristErledigt(status), status).toBe(false);
    }
    expect(
      taxNoticeFristErledigt('TEILABHILFE', {
        appealDeadline: new Date('2026-06-01'),
        appealFiledAt: new Date('2026-06-01'),
        appealFiledBy: 'staff-1',
      }),
    ).toBe(true);
    expect(
      taxNoticeFristErledigt('EINSPRUCH', {
        appealDeadline: new Date('2026-06-01'),
        appealFiledAt: new Date('2026-06-02'),
        appealFiledBy: 'staff-1',
      }),
    ).toBe(false);
    expect(
      taxNoticeFristErledigt('BESTANDSKRAEFTIG', {
        legalFinalAt: new Date('2026-06-01'),
        legalFinalBy: 'staff-1',
        legalFinalReason: 'Fristablauf und Aktenlage fachlich geprüft.',
      }),
    ).toBe(true);
    expect(
      taxNoticeFristErledigt('BESTANDSKRAEFTIG', {
        legalFinalAt: new Date('2026-06-01'),
        legalFinalBy: 'staff-1',
      }),
    ).toBe(false);
  });

  it('Klagefrist (§ 47 FGO): offen nach Einspruchsentscheidung, erledigt bei KLAGE/Bestandskraft', () => {
    expect(taxNoticeKlageFristErledigt('ZURUECKGEWIESEN')).toBe(false);
    // TEILABHILFE ist kein Klagefrist-Auslöser; die Loader-Abfrage nimmt den
    // Status deshalb gar nicht als Klagefrist auf. Ein etwaiger Altwert darf
    // jedenfalls nicht als nachgewiesen erledigt gelten.
    expect(taxNoticeKlageFristErledigt('TEILABHILFE')).toBe(false);
    expect(taxNoticeKlageFristErledigt('TEILEINSPRUCHSENTSCHEIDUNG')).toBe(false);
    expect(taxNoticeKlageFristErledigt('KLAGE')).toBe(false);
    expect(
      taxNoticeKlageFristErledigt('KLAGE', {
        klageDeadline: new Date('2026-06-01'),
        klageFiledAt: new Date('2026-06-01'),
        klageFiledBy: 'staff-1',
      }),
    ).toBe(true);
    expect(
      taxNoticeKlageFristErledigt('KLAGE', {
        klageDeadline: new Date('2026-06-01'),
        klageFiledAt: new Date('2026-06-02'),
        klageFiledBy: 'staff-1',
      }),
    ).toBe(false);
    expect(
      taxNoticeKlageFristErledigt('BESTANDSKRAEFTIG', {
        legalFinalAt: new Date('2026-06-01'),
        legalFinalBy: 'staff-1',
        legalFinalReason: 'Klagefrist und Aktenlage fachlich geprüft.',
      }),
    ).toBe(true);
    expect(
      taxNoticeKlageFristErledigt('BESTANDSKRAEFTIG', {
        klageDeadline: new Date('2026-05-20'),
        klageFiledAt: new Date('2026-05-20'),
        klageFiledBy: 'staff-1',
      }),
    ).toBe(true);
  });

  it('Anforderung: RESPONDED bleibt offen (Prüfung steht aus)', () => {
    expect(requestErledigt('CLOSED')).toBe(false);
    expect(requestErledigt('CLOSED', new Date('2026-06-01'), 'staff-1')).toBe(true);
    expect(requestErledigt('CANCELLED')).toBe(false);
    for (const offen of ['OPEN', 'IN_PROGRESS', 'RESPONDED']) {
      expect(requestErledigt(offen), offen).toBe(false);
    }
  });
});

// Review-Finding K-05 (Folgepunkt): Die Bestandskraft-Begründung zählt wie die
// Datenbank (app.legal_final_reason_sufficient). Dieselben Fälle prüft
// packages/db/src/__tests__/tax-notice-evidence.test.ts gegen Funktion und
// Constraint; bescheid-vorab-db.test.ts vergleicht beide Seiten direkt.
describe('Bestandskraft-Begründung (TAX-CONTROL-STATUS-001)', () => {
  const zeichen = (...codepoints: number[]) => String.fromCodePoint(...codepoints);

  it('entfernt am Rand genau die Zeichen, die String.prototype.trim() entfernt', () => {
    const trimmt: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (String.fromCharCode(cp).trim() === '') trimmt.push(cp);
    }
    expect(trimmt).toEqual([...RAND_LEERRAUM_CODEPOINTS]);
  });

  it('verlangt zehn Zeichen ohne Leerraum am Rand, gezählt in Codepunkten', () => {
    const faelle: Array<[string | null | undefined, boolean]> = [
      [null, false],
      [undefined, false],
      ['', false],
      ['\t\t\t\t\t\n\n\n\n\n', false],
      [zeichen(0xa0, 0xa0, 0xa0, 0x1680, 0x2007, 0x2028, 0x202f, 0x3000, 0x3000, 0xfeff), false],
      [' 123456789 ', false],
      ['\n\t  Akte geprüft \t\n', true],
      // Innerer Leerraum zählt wie bisher mit (trim().length in Formular und Action).
      ['a b c d e f', true],
      [zeichen(0x1f600).repeat(5), false],
      [zeichen(0x1f600).repeat(10), true],
      // NEL entfernt trim() nicht; er zählt also als Zeichen.
      [zeichen(0x85).repeat(10), true],
    ];
    for (const [reason, erwartet] of faelle) {
      expect(begruendungTragfaehig(reason), JSON.stringify(reason)).toBe(erwartet);
    }
  });

  it('schließt Einspruchs- und Klagefrist nur mit tragfähiger Begründung', () => {
    const bestandskraft = (legalFinalReason: string) => ({
      legalFinalAt: new Date('2026-06-01'),
      legalFinalBy: 'staff-1',
      legalFinalReason,
    });
    for (const erledigt of [taxNoticeFristErledigt, taxNoticeKlageFristErledigt]) {
      expect(erledigt('BESTANDSKRAEFTIG', bestandskraft('\t\t\t\t\t\n\n\n\n\n'))).toBe(false);
      expect(erledigt('BESTANDSKRAEFTIG', bestandskraft('  erledigt  '))).toBe(false);
      expect(erledigt('BESTANDSKRAEFTIG', bestandskraft('\n Fristablauf geprüft \n'))).toBe(true);
    }
  });
});

describe('bucketFor (UTC-Tagesgrenzen)', () => {
  const heute = new Date('2026-06-10T15:30:00Z');

  it('gestern → ÜBERFÄLLIG, auch bei späterer Uhrzeit', () => {
    expect(bucketFor(new Date('2026-06-09T23:59:00Z'), heute)).toBe('UEBERFAELLIG');
  });

  it('heute (frühere Uhrzeit) → HEUTE, nicht überfällig', () => {
    expect(bucketFor(new Date('2026-06-10T00:00:00Z'), heute)).toBe('HEUTE');
  });

  it('in 6 Tagen → DIESE_WOCHE, in 7 → SPÄTER', () => {
    expect(bucketFor(new Date('2026-06-16T00:00:00Z'), heute)).toBe('DIESE_WOCHE');
    expect(bucketFor(new Date('2026-06-17T00:00:00Z'), heute)).toBe('SPAETER');
  });
});

function eintrag(over: Partial<FristEintrag>): FristEintrag {
  return {
    quelle: 'WIEDERVORLAGE',
    kontrollart: 'OPERATIONAL_DUE_DATE',
    id: 'x',
    titel: 'T',
    clientId: 'c',
    clientName: 'C',
    faelligAm: new Date('2026-06-10'),
    erledigt: false,
    kontrollzustand: 'OPEN',
    kontrollhinweis: null,
    erledigtAm: null,
    erledigtVon: null,
    verantwortlich: null,
    verantwortlichId: null,
    href: '/x',
    ...over,
  };
}

describe('sortEintraege', () => {
  it('offene zuerst (älteste vorn), erledigte hinten (neueste vorn)', () => {
    const sorted = sortEintraege([
      eintrag({ id: 'done-alt', erledigt: true, faelligAm: new Date('2026-05-01') }),
      eintrag({ id: 'offen-spaet', faelligAm: new Date('2026-07-01') }),
      eintrag({ id: 'done-neu', erledigt: true, faelligAm: new Date('2026-06-01') }),
      eintrag({ id: 'offen-frueh', faelligAm: new Date('2026-04-01') }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['offen-frueh', 'offen-spaet', 'done-neu', 'done-alt']);
  });
});
