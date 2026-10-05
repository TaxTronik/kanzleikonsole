// Review-Befund P-08: Ein Glocken-Zähler-Takt pro Tab — kein Abruf bei
// verborgenem Tab, keine doppelten Abrufe mehrerer Komponenten oder parallel
// zu einem Seiten-Refresh. Fake-Timer + eigenes visibilitychange.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_POLL_INTERVAL_MS,
  createNotificationCountPoller,
  type UnreadSummary,
} from '../notification-count-poller';

class FakeDocument extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

// Takt-Abrufe laufen einen Timer-Tick nach dem Takt (setTimeout 0 wird
// innerhalb eines Ticks wie in Node mit 1 ms geplant).
const DEFER = 1;

let doc: FakeDocument;
let fetchSummary: ReturnType<typeof vi.fn<() => Promise<UnreadSummary | null>>>;

function createPoller() {
  return createNotificationCountPoller({ fetchSummary, source: () => doc });
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00.000Z') });
  doc = new FakeDocument();
  let unread = 0;
  fetchSummary = vi.fn(async () => ({ unread: ++unread, latestUnreadAt: null }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createNotificationCountPoller', () => {
  it('fragt bei sichtbarem Tab alle 30 s ab', async () => {
    const poller = createPoller();
    const seen: number[] = [];
    poller.subscribe((s) => seen.push(s.unread));

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_INTERVAL_MS - 1);
    expect(fetchSummary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + DEFER);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * NOTIFICATION_POLL_INTERVAL_MS);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('teilt Takt und jeden Abruf zwischen mehreren Komponenten eines Tabs', async () => {
    const poller = createPoller();
    const a = vi.fn();
    const b = vi.fn();
    poller.subscribe(a);
    poller.subscribe(b);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_INTERVAL_MS + DEFER);

    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ unread: 1, latestUnreadAt: null });
    expect(b).toHaveBeenCalledWith({ unread: 1, latestUnreadAt: null });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('fragt bei verborgenem Tab nicht ab und holt erst nach ≥ 30 s Abwesenheit sofort nach', async () => {
    const poller = createPoller();
    poller.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchSummary).not.toHaveBeenCalled();

    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSummary).toHaveBeenCalledTimes(1);

    // Kurzer Tab-Wechsel: nur der Rest-Countdown läuft weiter.
    await vi.advanceTimersByTimeAsync(20_000);
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(5_000);
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + DEFER);
    expect(fetchSummary).toHaveBeenCalledTimes(2);
  });

  it('verdoppelt einen laufenden Abruf nicht', async () => {
    let release: (value: UnreadSummary) => void = () => {};
    fetchSummary.mockImplementationOnce(
      () => new Promise<UnreadSummary>((resolve) => (release = resolve)),
    );
    const poller = createPoller();
    const seen = vi.fn();
    poller.subscribe(seen);

    const first = poller.pollNow();
    const second = poller.pollNow();
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    release({ unread: 7, latestUnreadAt: null });
    await Promise.all([first, second]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('lässt den Rückkehr-Abruf aus, wenn ein Seiten-Refresh den Zähler mitliefert', async () => {
    const poller = createPoller();
    poller.subscribe(() => {});
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Reihenfolge der Listener egal: erst Glocke, dann AutoRefresh …
    doc.setHidden(false);
    poller.markFresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSummary).not.toHaveBeenCalled();

    // … und der Takt beginnt nach dem Refresh neu.
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_INTERVAL_MS - 1);
    expect(fetchSummary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + DEFER);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
  });

  it('stoppt den Takt mit dem letzten Abonnenten', async () => {
    const poller = createPoller();
    const off1 = poller.subscribe(() => {});
    const off2 = poller.subscribe(() => {});
    off1();
    expect(vi.getTimerCount()).toBe(1);
    off2();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * NOTIFICATION_POLL_INTERVAL_MS);
    expect(fetchSummary).not.toHaveBeenCalled();
  });

  it('übersteht Fehler und leere Antworten ohne den Takt zu verlieren', async () => {
    fetchSummary.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    const poller = createPoller();
    const seen = vi.fn();
    poller.subscribe(seen);

    await vi.advanceTimersByTimeAsync(3 * NOTIFICATION_POLL_INTERVAL_MS + DEFER);

    expect(fetchSummary).toHaveBeenCalledTimes(3);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
