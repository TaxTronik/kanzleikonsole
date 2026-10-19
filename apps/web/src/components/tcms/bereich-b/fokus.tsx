'use client';

// Setzt den Fokus beim Öffnen eines Detailbereichs auf dessen Überschrift
// (TCMS Stufe 3, Bereich B), damit Tastatur- und Screenreader-Nutzende nach
// dem Klick auf eine Zeile dort weiterlesen. Wechselt das Ziel (anderes
// Risiko), springt der Fokus erneut.
import { useEffect } from 'react';

export function FokusBeimOeffnen({ ziel }: { ziel: string }) {
  useEffect(() => {
    const element = document.getElementById(ziel);
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: 'nearest' });
  }, [ziel]);
  return null;
}
