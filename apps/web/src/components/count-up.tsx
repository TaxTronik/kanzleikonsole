'use client';

import { useEffect, useState } from 'react';
import { useAccessibleDisplayReducedMotion } from './accessible-display';

interface MotionPreference {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
}

/** Zeit-/Framefunktionen sind injizierbar, damit Abbruch und Bewegungsschutz testbar bleiben. */
export function startCountUpAnimation({
  value,
  enabled,
  reducedMotion,
  onValue,
  now,
  requestFrame,
  cancelFrame,
}: {
  value: number;
  enabled: boolean;
  reducedMotion: MotionPreference;
  onValue: (value: number) => void;
  now: () => number;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (frame: number) => void;
}): () => void {
  if (!enabled || value === 0 || reducedMotion.matches) {
    onValue(value);
    return () => {};
  }

  const start = now();
  let frame: number | null = null;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (frame !== null) cancelFrame(frame);
    reducedMotion.removeEventListener('change', onMotionChange);
  }

  function onMotionChange(event: { matches: boolean }) {
    if (!event.matches || stopped) return;
    stop();
    onValue(value);
  }

  function tick(time: number) {
    if (stopped) return;
    frame = null;
    const progress = Math.max(0, Math.min(1, (time - start) / 600));
    onValue(progress === 1 ? value : Math.round(value * (1 - Math.pow(1 - progress, 3))));
    if (progress < 1) frame = requestFrame(tick);
    else stop();
  }

  reducedMotion.addEventListener('change', onMotionChange);
  onValue(0);
  frame = requestFrame(tick);
  return stop;
}

/**
 * Zählt einen Zahlenwert beim ersten Mount kurz hoch (600 ms, ease-out-cubic).
 * Nur im Modern-UI-Modus ohne persönliche/OS-Bewegungsreduktion — sonst steht
 * der Endwert sofort. Eine neu aktivierte Bewegungsreduktion beendet den Lauf.
 */
export function CountUp({ value }: { value: number }) {
  const accessibleDisplayEnabled = useAccessibleDisplayReducedMotion();
  const [display, setDisplay] = useState(value);

  useEffect(
    () =>
      startCountUpAnimation({
        value,
        enabled:
          !accessibleDisplayEnabled && document.documentElement.classList.contains('ui-modern'),
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)'),
        onValue: setDisplay,
        now: () => performance.now(),
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
      }),
    [value, accessibleDisplayEnabled],
  );

  // Auch vor der Effect-Cleanup darf der neu aktivierte Modus keinen Zwischenwert zeigen.
  return <>{accessibleDisplayEnabled ? value : display}</>;
}
