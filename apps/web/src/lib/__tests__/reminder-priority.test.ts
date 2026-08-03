import { describe, expect, it } from 'vitest';
import {
  PRIORITY_BADGE,
  PRIORITY_LABEL,
  REMINDER_PRIORITIES,
  byPriorityThenDue,
} from '../reminder-priority';

describe('byPriorityThenDue', () => {
  it('zieht Dringendes nach oben — auch gegen ein früheres Datum', () => {
    // Genau der Zweck des „Bumpens": die hochgestufte Aufgabe muss obenauf
    // liegen, obwohl ihr Termin weiter weg ist.
    const sortiert = [
      { id: 'normal-frueh', priority: 'NORMAL' as const, dueDate: '2026-08-01' },
      { id: 'dringend-spaet', priority: 'URGENT' as const, dueDate: '2026-12-31' },
      { id: 'hoch-mittel', priority: 'HIGH' as const, dueDate: '2026-09-01' },
    ].sort(byPriorityThenDue);

    expect(sortiert.map((r) => r.id)).toEqual(['dringend-spaet', 'hoch-mittel', 'normal-frueh']);
  });

  it('sortiert bei gleicher Priorität nach Fälligkeit', () => {
    const sortiert = [
      { priority: 'NORMAL' as const, dueDate: '2026-09-10' },
      { priority: 'NORMAL' as const, dueDate: '2026-08-20' },
    ].sort(byPriorityThenDue);

    expect(sortiert.map((r) => r.dueDate)).toEqual(['2026-08-20', '2026-09-10']);
  });

  it('ist stabil gegenüber der Reihenfolge der Skala', () => {
    expect(REMINDER_PRIORITIES).toEqual(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
  });
});

describe('Anzeige', () => {
  it('hat für jede Stufe ein Label', () => {
    for (const p of REMINDER_PRIORITIES) expect(PRIORITY_LABEL[p]).toBeTruthy();
  });

  it('markiert NORMAL bewusst NICHT mit einem Badge', () => {
    // Sonst trägt jede Zeile ein Abzeichen und die Hervorhebung verpufft.
    expect(PRIORITY_BADGE.NORMAL).toBeNull();
    expect(PRIORITY_BADGE.URGENT).toBeTruthy();
    expect(PRIORITY_BADGE.HIGH).toBeTruthy();
    expect(PRIORITY_BADGE.LOW).toBeTruthy();
  });
});
