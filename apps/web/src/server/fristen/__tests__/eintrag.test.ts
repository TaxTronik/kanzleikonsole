import { describe, it, expect } from 'vitest';
import {
  taxDeadlineErledigt,
  taxNoticeFristErledigt,
  requestErledigt,
  bucketFor,
  sortEintraege,
  type FristEintrag,
} from '../eintrag';

// Status-Wahrheitstabellen des Fristenkontrollbuchs — eine falsche Zuordnung
// hieße: eine offene Frist erscheint als erledigt (Haftungsrisiko) oder
// umgekehrt (Rauschen).
describe('Erledigt-Wahrheitstabellen', () => {
  it('Steuertermin: nur DONE/SKIPPED erledigt — OVERDUE bleibt offen', () => {
    expect(taxDeadlineErledigt('DONE')).toBe(true);
    expect(taxDeadlineErledigt('SKIPPED')).toBe(true);
    for (const offen of ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'SUBMITTED', 'OVERDUE']) {
      expect(taxDeadlineErledigt(offen), offen).toBe(false);
    }
  });

  it('Einspruchsfrist: GEPRUEFT ist NICHT erledigt (Entscheidung steht aus)', () => {
    expect(taxNoticeFristErledigt('NEU')).toBe(false);
    expect(taxNoticeFristErledigt('GEPRUEFT')).toBe(false);
    for (const done of ['EINSPRUCH', 'ABGEHOLFEN', 'ZURUECKGEWIESEN', 'RECHTSKRAEFTIG']) {
      expect(taxNoticeFristErledigt(done), done).toBe(true);
    }
  });

  it('Anforderung: RESPONDED bleibt offen (Prüfung steht aus)', () => {
    expect(requestErledigt('CLOSED')).toBe(true);
    expect(requestErledigt('CANCELLED')).toBe(true);
    for (const offen of ['OPEN', 'IN_PROGRESS', 'RESPONDED']) {
      expect(requestErledigt(offen), offen).toBe(false);
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
    quelle: 'WIEDERVORLAGE', id: 'x', titel: 'T', clientId: 'c', clientName: 'C',
    faelligAm: new Date('2026-06-10'), erledigt: false, erledigtAm: null,
    erledigtVon: null, verantwortlich: null, verantwortlichId: null, href: '/x',
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
