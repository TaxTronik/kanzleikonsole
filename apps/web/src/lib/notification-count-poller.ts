// =============================================================================
// Ungelesen-Zähler der Glocke: EIN Abruf-Takt pro Tab (Review-Befund P-08).
//
// - Alle 30 s bei sichtbarem Tab; im Hintergrund pausiert (kein Abruf).
// - Rückkehr nach ≥ 30 s Abwesenheit: sofort zählen; kürzere Tab-Wechsel
//   setzen nur den Countdown fort.
// - Mehrere Abonnenten (Komponenten) teilen sich Takt und jeden Abruf; ein
//   laufender Abruf wird nicht verdoppelt.
// - Ein Seiten-Refresh liest den Zähler im Staff-Layout ohnehin mit
//   (`markFresh`): Der nächste Takt beginnt dann neu, und ein im selben Moment
//   fälliger Rückkehr-Abruf entfällt.
// Es gibt keinen Server-Push (SSE/WebSocket); daher bleibt es beim Polling.
// =============================================================================

import {
  startVisibilityInterval,
  type VisibilityInterval,
  type VisibilitySource,
} from './visibility-interval';

export const NOTIFICATION_POLL_INTERVAL_MS = 30_000;

export interface UnreadSummary {
  unread: number;
  latestUnreadAt: string | null;
}

export interface NotificationCountPollerOptions {
  fetchSummary: () => Promise<UnreadSummary | null>;
  intervalMs?: number;
  resumeAfterHiddenMs?: number;
  /** Standard: `document`, erst beim ersten Abonnenten gelesen (SSR-sicher). */
  source?: () => VisibilitySource;
  now?: () => number;
}

export interface NotificationCountPoller {
  /** Meldet jeden Zählerstand; der erste Abonnent startet, der letzte stoppt den Takt. */
  subscribe(listener: (summary: UnreadSummary) => void): () => void;
  /** Sofort zählen (z. B. nach einer Navigation) und den Takt neu beginnen. */
  pollNow(): Promise<void>;
  /** Ein Seiten-Refresh hat den Zähler gerade mitgeliefert. */
  markFresh(): void;
}

export function createNotificationCountPoller(
  options: NotificationCountPollerOptions,
): NotificationCountPoller {
  const intervalMs = options.intervalMs ?? NOTIFICATION_POLL_INTERVAL_MS;
  const resumeAfterHiddenMs = options.resumeAfterHiddenMs ?? intervalMs;
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(summary: UnreadSummary) => void>();
  let schedule: VisibilityInterval | null = null;
  let inFlight: Promise<void> | null = null;
  let freshAt = Number.NEGATIVE_INFINITY;

  function poll(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const summary = await options.fetchSummary();
        if (summary) for (const listener of [...listeners]) listener(summary);
      } catch {
        // Nächster Takt versucht es erneut.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  // Takt- und Rückkehr-Abrufe einen Tick zurückstellen: Löst dasselbe Ereignis
  // (Rückkehr in den Tab) auch einen Seiten-Refresh aus, entfällt der Abruf —
  // unabhängig davon, welcher Listener zuerst läuft.
  function onTick(): void {
    const tickAt = now();
    setTimeout(() => {
      if (freshAt < tickAt) void poll();
    }, 0);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      schedule ??= startVisibilityInterval({
        intervalMs,
        resumeAfterHiddenMs,
        onTick,
        source: options.source?.(),
        now,
      });
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || !schedule) return;
        schedule.stop();
        schedule = null;
      };
    },
    pollNow() {
      schedule?.reset();
      return poll();
    },
    markFresh() {
      freshAt = now();
      schedule?.reset();
    },
  };
}

async function fetchUnreadSummary(): Promise<UnreadSummary | null> {
  const res = await fetch('/api/staff/notifications/count', { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as UnreadSummary;
}

/** Der eine Poller dieses Tabs (Modul-Singleton im Browser). */
export const notificationCountPoller = createNotificationCountPoller({
  fetchSummary: fetchUnreadSummary,
});
