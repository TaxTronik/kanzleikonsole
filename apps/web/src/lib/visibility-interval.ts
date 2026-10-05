// =============================================================================
// Sichtbarkeitsabhängiger Takt für Live-Aktualisierungen (Review-Befund P-08).
//
// Der Countdown läuft nur, solange der Tab sichtbar ist. Im Hintergrund
// pausiert er (kein Timer, also auch keine Abfrage); nach einer kurzen
// Abwesenheit läuft die Restzeit weiter. War der Tab mindestens
// `resumeAfterHiddenMs` verborgen, tickt er bei der Rückkehr sofort einmal und
// beginnt danach von vorn.
//
// Bis auf das übergebene `document`-Abbild DOM-frei: Tests steuern Uhr und
// `visibilitychange` selbst (Fake-Timer, eigenes EventTarget).
// =============================================================================

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type VisibilityTickReason = 'interval' | 'resume';

export interface VisibilityIntervalOptions {
  /** Abstand der Ticks bei sichtbarem Tab. */
  intervalMs: number;
  /** Mindestabwesenheit, nach der die Rückkehr sofort einen Tick auslöst. */
  resumeAfterHiddenMs: number;
  onTick: (reason: VisibilityTickReason) => void;
  /** Standard: `document` (erst beim Start gelesen, SSR-sicher). */
  source?: VisibilitySource;
  now?: () => number;
}

export interface VisibilityInterval {
  /** Countdown neu beginnen, z. B. weil gerade frische Daten kamen. */
  reset(): void;
  stop(): void;
}

export function startVisibilityInterval(options: VisibilityIntervalOptions): VisibilityInterval {
  const { intervalMs, resumeAfterHiddenMs, onTick } = options;
  const source = options.source ?? document;
  const now = options.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remainingMs = intervalMs;
  let armedAt = 0;
  let hiddenSince: number | null = source.hidden ? now() : null;

  function arm(ms: number): void {
    armedAt = now();
    timer = setTimeout(fire, ms);
  }

  function disarm(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function fire(): void {
    timer = null;
    remainingMs = intervalMs;
    // Erst neu planen: ein werfender Handler darf den Takt nicht beenden.
    arm(intervalMs);
    onTick('interval');
  }

  function onVisibilityChange(): void {
    if (source.hidden) {
      if (hiddenSince !== null) return;
      if (timer !== null) remainingMs = Math.max(0, remainingMs - (now() - armedAt));
      disarm();
      hiddenSince = now();
      return;
    }
    if (hiddenSince === null) return;
    const awayMs = now() - hiddenSince;
    hiddenSince = null;
    if (awayMs >= resumeAfterHiddenMs) {
      remainingMs = intervalMs;
      arm(intervalMs);
      onTick('resume');
      return;
    }
    arm(remainingMs);
  }

  source.addEventListener('visibilitychange', onVisibilityChange);
  if (hiddenSince === null) arm(remainingMs);

  return {
    reset() {
      remainingMs = intervalMs;
      if (hiddenSince !== null) return;
      disarm();
      arm(intervalMs);
    },
    stop() {
      disarm();
      source.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
