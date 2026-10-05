// Review-Befund P-08: Takt pausiert bei verborgenem Tab, Rückkehr lädt erst
// nach einer Mindestabwesenheit sofort. Fake-Timer + eigenes visibilitychange.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVisibilityInterval, type VisibilityTickReason } from '../visibility-interval';

class FakeDocument extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

let doc: FakeDocument;
let ticks: VisibilityTickReason[];

function start(intervalMs = 120_000, resumeAfterHiddenMs = 60_000) {
  return startVisibilityInterval({
    intervalMs,
    resumeAfterHiddenMs,
    onTick: (reason) => ticks.push(reason),
    source: doc,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
  doc = new FakeDocument();
  ticks = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startVisibilityInterval', () => {
  it('tickt bei sichtbarem Tab im festen Abstand', () => {
    start();
    vi.advanceTimersByTime(119_999);
    expect(ticks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ticks).toEqual(['interval']);
    vi.advanceTimersByTime(240_000);
    expect(ticks).toEqual(['interval', 'interval', 'interval']);
  });

  it('pausiert bei verborgenem Tab vollständig (kein Timer, kein Tick)', () => {
    start();
    vi.advanceTimersByTime(30_000);
    doc.setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(ticks).toEqual([]);
  });

  it('setzt nach kurzer Abwesenheit nur den Rest-Countdown fort', () => {
    start();
    vi.advanceTimersByTime(100_000); // 20 s Rest
    doc.setHidden(true);
    vi.advanceTimersByTime(59_999); // knapp unter 60 s weg
    doc.setHidden(false);
    expect(ticks).toEqual([]);
    vi.advanceTimersByTime(19_999);
    expect(ticks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ticks).toEqual(['interval']);
  });

  it('tickt nach ≥ 60 s Abwesenheit sofort und beginnt den Takt neu', () => {
    start();
    vi.advanceTimersByTime(10_000);
    doc.setHidden(true);
    vi.advanceTimersByTime(60_000);
    doc.setHidden(false);
    expect(ticks).toEqual(['resume']);
    vi.advanceTimersByTime(119_999);
    expect(ticks).toEqual(['resume']);
    vi.advanceTimersByTime(1);
    expect(ticks).toEqual(['resume', 'interval']);
  });

  it('ignoriert doppelte Sichtbarkeitsereignisse', () => {
    start();
    doc.setHidden(false);
    doc.setHidden(false);
    expect(vi.getTimerCount()).toBe(1);
    doc.setHidden(true);
    doc.setHidden(true);
    vi.advanceTimersByTime(30_000);
    doc.setHidden(false);
    vi.advanceTimersByTime(120_000);
    expect(ticks).toEqual(['interval']);
  });

  it('startet im Hintergrund pausiert und holt bei langer Abwesenheit sofort nach', () => {
    doc.hidden = true;
    start();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * 60_000);
    doc.setHidden(false);
    expect(ticks).toEqual(['resume']);
  });

  it('reset beginnt den Countdown neu, stop entfernt Timer und Listener', () => {
    const interval = start();
    vi.advanceTimersByTime(100_000);
    interval.reset();
    vi.advanceTimersByTime(100_000);
    expect(ticks).toEqual([]);
    vi.advanceTimersByTime(20_000);
    expect(ticks).toEqual(['interval']);
    interval.stop();
    expect(vi.getTimerCount()).toBe(0);
    doc.setHidden(true);
    vi.advanceTimersByTime(120_000);
    doc.setHidden(false);
    vi.advanceTimersByTime(240_000);
    expect(ticks).toEqual(['interval']);
  });

  it('behält den Takt, wenn ein Tick-Handler wirft', () => {
    let calls = 0;
    startVisibilityInterval({
      intervalMs: 1_000,
      resumeAfterHiddenMs: 1_000,
      source: doc,
      onTick: () => {
        calls += 1;
        throw new Error('boom');
      },
    });
    expect(() => vi.advanceTimersByTime(1_000)).toThrow('boom');
    expect(() => vi.advanceTimersByTime(1_000)).toThrow('boom');
    expect(calls).toBe(2);
  });
});
