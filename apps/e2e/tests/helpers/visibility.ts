import type { Locator } from '@playwright/test';

// Locator.isVisible() wartet nicht: Playwright ignoriert dort die Option
// timeout und antwortet sofort. Seit staff/(protected)/loading.tsx zuerst ein
// Skelett streamt, fand eine solche Prüfung direkt nach der Navigation oft
// nichts (Flakes der CI-Sitzung vom 8.10.). Erwartete Elemente prüfen die
// Specs deshalb web-first mit expect(...).toBeVisible(); echte Verzweigungen
// warten zuerst auf einen Seitenanker oder nutzen die Helfer hier
// (Guard: scripts/check-paranoid-e2e.mjs).

/** Wartezeit auf den ersten Inhalt einer gestreamten Seite (wie 06-actions). */
export const PAGE_READY_TIMEOUT = 15_000;

/** Erster sichtbarer Treffer aus allen Locatoren (Vereinigung, DOM-Reihenfolge). */
export function anyVisible(first: Locator, ...rest: Locator[]): Locator {
  return rest
    .reduce((all, locator) => all.or(locator), first)
    .filter({ visible: true })
    .first();
}

/**
 * Echte Verzweigung ohne gemeinsamen Seitenanker: wartet höchstens `timeout`
 * Millisekunden, ob ein Treffer sichtbar wird, und liefert true/false statt
 * eines Fehlers. Das ist die Bedeutung, die `isVisible` mit timeout haben
 * sollte; für Negativprüfungen ist es das Beobachtungsfenster.
 */
export function becomesVisible(locator: Locator, timeout: number): Promise<boolean> {
  return anyVisible(locator)
    .waitFor({ state: 'visible', timeout })
    .then(
      () => true,
      () => false,
    );
}

/**
 * Wartet, bis einer der Kandidaten sichtbar ist, und liefert den ersten
 * sichtbaren in der Reihenfolge der Liste (Präferenz), sonst null. Für
 * Fallback-Ketten alternativer Selektoren desselben Bedienelements.
 */
export async function firstVisibleCandidate(
  candidates: readonly [Locator, ...Locator[]],
  timeout = PAGE_READY_TIMEOUT,
): Promise<Locator | null> {
  const [first, ...rest] = candidates;
  if (!(await becomesVisible(anyVisible(first, ...rest), timeout))) return null;
  for (const candidate of candidates) {
    const visible = anyVisible(candidate);
    if (await visible.isVisible()) return visible;
  }
  return null;
}
