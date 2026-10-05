// Review-Befund P-08: AutoRefresh ist Opt-in (nur Live-Seiten), pausiert bei
// verborgenem Tab und lädt bei der Rückkehr erst nach ≥ 60 s Abwesenheit neu.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldReloadRestoredPage, startAutoRefresh } from '../auto-refresh';
import {
  LIVE_REFRESH_ROUTES,
  REFRESH_INTERVAL_MS,
  RESUME_REFRESH_AFTER_HIDDEN_MS,
  isAutomaticRefreshEnabled,
} from '@/lib/live-refresh-policy';

const CLIENT = '01234567-89ab-4def-8abc-0123456789ab';

class FakeDocument extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

describe('AutoRefresh-Route-Policy (Opt-in)', () => {
  it('pollt hoechstens alle zwei Minuten und lädt bei Rückkehr erst nach einer Minute', () => {
    expect(REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(120_000);
    expect(RESUME_REFRESH_AFTER_HIDDEN_MS).toBeGreaterThanOrEqual(60_000);
  });

  it.each([
    '/staff/dashboard',
    '/staff/work',
    '/staff/admin/jobs',
    '/portal/dashboard',
    '/portal/inbox',
    `/portal/inbox/${CLIENT}`,
  ])('aktualisiert die Live-Seite %s', (pathname) => {
    expect(isAutomaticRefreshEnabled(pathname)).toBe(true);
  });

  it.each([
    '/staff/gwg',
    '/staff/inbox',
    '/staff/year-end',
    '/staff/admin',
    '/staff/clients',
    `/staff/clients/${CLIENT}`,
    `/staff/clients/${CLIENT}/gwg`,
    `/staff/clients/${CLIENT}/workflows`,
    '/staff/admin/audit',
    '/staff/tax-deadlines',
    '/portal/inbox/new',
    '/portal/documents',
  ])('lädt %s nicht periodisch neu', (pathname) => {
    expect(isAutomaticRefreshEnabled(pathname)).toBe(false);
  });

  it('begründet jede Live-Route', () => {
    for (const route of LIVE_REFRESH_ROUTES) expect(route.reason.length).toBeGreaterThan(40);
  });

  it('erzwingt nach Wiederherstellung aus dem Back/Forward Cache eine neue Auth-Pruefung', () => {
    expect(shouldReloadRestoredPage(true)).toBe(true);
    expect(shouldReloadRestoredPage(false)).toBe(false);
  });
});

describe('startAutoRefresh', () => {
  let doc: FakeDocument;
  let refresh: ReturnType<typeof vi.fn<() => void>>;
  let typing: boolean;

  function start(pathname = '/staff/dashboard') {
    return startAutoRefresh({ pathname, refresh, isTyping: () => typing, source: doc });
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
    doc = new FakeDocument();
    refresh = vi.fn<() => void>();
    typing = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lädt eine Live-Seite alle 120 s bei sichtbarem Tab neu', () => {
    start();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('pausiert im Hintergrund und lädt nach kurzer Abwesenheit nicht sofort', () => {
    start();
    vi.advanceTimersByTime(60_000);
    doc.setHidden(true);
    vi.advanceTimersByTime(59_000);
    doc.setHidden(false);
    expect(refresh).not.toHaveBeenCalled();
    // Restzeit des Takts (60 s) läuft weiter.
    vi.advanceTimersByTime(59_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('lädt bei der Rückkehr nach mindestens 60 s Abwesenheit sofort neu', () => {
    start();
    doc.setHidden(true);
    vi.advanceTimersByTime(30 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    doc.setHidden(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stört keine laufende Eingabe', () => {
    start();
    typing = true;
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
    expect(refresh).not.toHaveBeenCalled();
    typing = false;
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('plant auf Seiten ohne Live-Zustand weder Timer noch Refresh', () => {
    const stop = start('/staff/gwg');
    expect(vi.getTimerCount()).toBe(0);
    doc.setHidden(true);
    vi.advanceTimersByTime(10 * 60_000);
    doc.setHidden(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it('räumt Timer und Listener beim Seitenwechsel ab', () => {
    const stop = start();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    doc.setHidden(true);
    vi.advanceTimersByTime(10 * 60_000);
    doc.setHidden(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
