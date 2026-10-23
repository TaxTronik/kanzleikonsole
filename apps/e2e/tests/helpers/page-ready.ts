import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { PAGE_READY_TIMEOUT } from './visibility';

// Seitenbereitschaft ohne den Playwright-Ladezustand networkidle. Der wartet,
// bis 500 ms lang keine Anfrage offen ist, und zählt verworfene Next-Prefetches
// dauerhaft als offen: In CI-Lauf 1207 hing `/staff/profile` so 180 s an acht
// `_rsc`-Prefetches, die der Server Millisekunden später mit neuem Schlüssel
// beantwortet hatte (Guard: scripts/check-paranoid-e2e.mjs). Bereit ist eine
// Seite stattdessen, wenn
//   1. das Dokument geladen ist (`load`: vollständig gestreamtes HTML und die
//      Startskripte; React hydriert danach noch),
//   2. kein Lade-Platzhalter mehr steht (`aria-busy="true"`: loading.tsx,
//      gestreamte Blöcke, nachgeladene Komponenten) und
//   3. React Layout und Seiteninhalt hydriert hat.
// Was eine Seite danach selbst abruft, prüfen die Specs am konkreten Element
// oder per waitForResponse auf genau diese Anfrage.

// React hängt beim Hydrieren seine Props an jedes DOM-Element, und zwar erst,
// wenn der Teilbaum darunter fertig ist (eigene Suspense-Grenzen darin folgen
// später). Ein Element mit Props steht samt Inhalt unter React-Kontrolle.
const REACT_PROPS = '__reactProps$';

/** Wartet, bis React das Element samt Inhalt hydriert hat. */
export async function expectHydrated(locator: Locator, message: string): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate(
          (element, prefix) => Object.keys(element).some((key) => key.startsWith(prefix)),
          REACT_PROPS,
        ),
      { message, timeout: PAGE_READY_TIMEOUT },
    )
    .toBe(true);
}

/**
 * Bereitschaft der aktuellen Seite (siehe oben). `anchor` ist das Element, mit
 * dem der Test als Nächstes arbeitet; es muss sichtbar und hydriert sein.
 */
export async function expectPageReady(page: Page, anchor?: Locator): Promise<void> {
  const main = page.locator('#main-content');
  await expect(main, 'Seite muss ihren Hauptinhalt rendern').toBeVisible({
    timeout: PAGE_READY_TIMEOUT,
  });
  await expect(
    page.locator('[aria-busy="true"]'),
    'Lade-Platzhalter müssen dem gestreamten Inhalt gewichen sein',
  ).toHaveCount(0, { timeout: PAGE_READY_TIMEOUT });
  // Der Seiteninhalt steht direkt unter <main> (Layout: Kopfleiste, dann
  // children); seine obersten Elemente decken die Seiten-Suspense ab.
  await expect
    .poll(
      () =>
        main.evaluate(
          (element, prefix) =>
            [element, ...element.children].every((node) =>
              Object.keys(node).some((key) => key.startsWith(prefix)),
            ),
          REACT_PROPS,
        ),
      { message: 'React muss Layout und Seiteninhalt hydriert haben', timeout: PAGE_READY_TIMEOUT },
    )
    .toBe(true);
  if (anchor) {
    await expect(anchor).toBeVisible({ timeout: PAGE_READY_TIMEOUT });
    await expectHydrated(anchor, 'Bedienelement des Tests muss hydriert sein');
  }
}

/** Navigiert und wartet auf die Bereitschaft der Zielseite. */
export async function gotoReady(
  page: Page,
  url: string,
  anchor?: Locator,
): Promise<Response | null> {
  const response = await page.goto(url, { waitUntil: 'load' });
  await expectPageReady(page, anchor);
  return response;
}

/** Lädt das Dokument neu und wartet auf die Bereitschaft der Seite. */
export async function reloadReady(page: Page, anchor?: Locator): Promise<Response | null> {
  const response = await page.reload({ waitUntil: 'load' });
  await expectPageReady(page, anchor);
  return response;
}
