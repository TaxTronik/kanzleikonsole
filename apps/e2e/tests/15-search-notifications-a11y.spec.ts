import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

const PROFILE = '/staff/profile';
const DISPLAY_LABEL = 'Barrierearmen Anzeigemodus aktivieren';
const OPTION_ATTRIBUTES = [
  'data-accessible-font-size',
  'data-accessible-spacing',
  'data-accessible-contrast',
  'data-accessible-reduce-motion',
] as const;

interface NotificationFixture {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
  readAt: string | null;
}

async function installReadOnlyFixtures(page: Page) {
  const state = {
    unread: 0,
    latestUnreadAt: null as string | null,
    items: [] as NotificationFixture[],
  };
  await page.route('**/api/staff/notifications/count', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      json: { unread: state.unread, latestUnreadAt: state.latestUnreadAt },
    });
  });
  await page.route('**/api/staff/notifications/recent', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: state });
  });
  await page.route('**/api/staff/search?*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      json: {
        results: Array.from({ length: 30 }, (_, index) => ({
          type: 'kb_article',
          id: `a11y-search-${index + 1}`,
          title: `Testartikel ${index + 1}`,
          subtitle: 'Wissensartikel',
          href: '/staff/knowledge',
        })),
      },
    });
  });
  return state;
}

function modeCheckbox(page: Page) {
  return page.getByRole('checkbox', { name: DISPLAY_LABEL, exact: true });
}

async function currentOptions(page: Page): Promise<(string | null)[]> {
  const marker = page.locator('body [data-accessible-display]');
  return Promise.all(OPTION_ATTRIBUTES.map((attribute) => marker.getAttribute(attribute)));
}

async function setMode(page: Page, enabled: boolean): Promise<void> {
  const checkbox = modeCheckbox(page);
  await expect(checkbox).toHaveAttribute('aria-disabled', 'false');
  if ((await checkbox.isChecked()) !== enabled) {
    await checkbox.setChecked(enabled);
    await expect(
      page.getByRole('status').filter({ hasText: /^Anzeigeeinstellung gespeichert\.$/ }),
    ).toBeVisible();
    await expect(checkbox).toHaveAttribute('aria-disabled', 'false');
  }
  await expect(checkbox).toBeChecked({ checked: enabled });
  await expect(page.locator('body [data-accessible-display]')).toHaveAttribute(
    'data-accessible-display',
    String(enabled),
  );
}

async function startProfile(page: Page) {
  const notifications = await installReadOnlyFixtures(page);
  await loginAsAdmin(page);
  await page.goto(PROFILE, { waitUntil: 'networkidle' });
  const originalMode = await modeCheckbox(page).isChecked();
  const originalOptions = await currentOptions(page);
  const unexpectedWrites: string[] = [];
  // Auth is complete. During these UI tests only the personal display-setting
  // action may write; fabricated notification ids must never reach a read action.
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === new URL(page.url()).origin &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
      url.pathname !== PROFILE
    ) {
      unexpectedWrites.push(`${request.method()} ${url.pathname}`);
    }
  });
  return {
    notifications,
    async restore() {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(PROFILE, { waitUntil: 'networkidle' });
      await setMode(page, originalMode);
      expect(await currentOptions(page), 'Individuelle Anzeigeoptionen unverändert lassen').toEqual(
        originalOptions,
      );
      expect(unexpectedWrites, 'Keine fachlichen POSTs oder Gelesen-Aktionen auslösen').toEqual([]);
    },
  };
}

async function expectInsideViewport(panel: Locator): Promise<void> {
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return Math.max(-rect.left, -rect.top, rect.right - innerWidth, rect.bottom - innerHeight);
      }),
    )
    .toBeLessThanOrEqual(1);
}

async function expectActiveOptionVisible(panel: Locator): Promise<void> {
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const option = element.querySelector('[aria-selected="true"]')!;
        const bounds = element.getBoundingClientRect();
        const active = option.getBoundingClientRect();
        const top = bounds.top + element.clientTop;
        const bottom = top + element.clientHeight;
        // Exceptionally tall entries start visibly at their title; ordinary
        // entries must fit entirely, including the last result in the list.
        return Math.max(
          top - active.top,
          Math.min(active.bottom, active.top + element.clientHeight) - bottom,
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}

async function expectNoPanelViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await test.info().attach('axe-notification-dialog.json', {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json',
  });
  expect(result.violations).toEqual([]);
}

test.describe('Such- und Benachrichtigungspanels: Tastatur und Lesen', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('viele Suchtreffer scrollen lokal; Home, End, Tab und Escape funktionieren bei 320 × 240', async ({
    page,
  }) => {
    const profile = await startProfile(page);
    try {
      for (const enabled of [false, true]) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await setMode(page, enabled);
        await page.setViewportSize({ width: 320, height: 240 });
        const search = page.getByRole('combobox', { name: 'Globale Suche' });
        await search.fill('a11y-fixture');
        const panel = page.getByRole('listbox', { name: 'Suchergebnisse' });
        await expect(panel.getByRole('option')).toHaveCount(30);
        await expectInsideViewport(panel);
        const main = page.locator('main');
        const initialScroll = await main.evaluate((element) => element.scrollTop);

        await search.press('End');
        await expect(panel.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
        await expectActiveOptionVisible(panel);
        expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expect(search).toBeFocused();
        expect(await main.evaluate((element) => element.scrollTop)).toBe(initialScroll);

        await search.press('Home');
        await expect(panel.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
        await expectActiveOptionVisible(panel);
        await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await main.evaluate((element) => element.scrollTop)).toBe(initialScroll);

        await search.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect(search).toBeFocused();
        await search.press('ArrowDown');
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
        await search.press('Tab');
        await expect(panel).toHaveCount(0);
        await expect(search).not.toBeFocused();
        await search.focus();
        await expect(panel).toBeVisible();
        await search.press('Shift+Tab');
        await expect(panel).toHaveCount(0);
        await expect(search).not.toBeFocused();
      }
    } finally {
      await profile.restore();
    }
  });

  test('lange Benachrichtigungen bleiben vollständig lesbar; Dialog und Fußaktionen sind tastaturerreichbar', async ({
    page,
  }) => {
    const profile = await startProfile(page);
    const createdAt = new Date().toISOString();
    const longTitle =
      'Langer Benachrichtigungstitel: Rückfragen und Unterlagen für das gesamte Team vollständig sichtbar bis zum Titelende.';
    const longBody =
      'Diese ausschließlich lokale Testnachricht enthält mehrere ausführliche Zeilen.\nAuch weitere Hinweise bleiben sichtbar und werden im persönlichen Anzeigemodus nicht nach zwei Zeilen abgeschnitten. Das ist das Textende.';
    profile.notifications.items = Array.from({ length: 10 }, (_, index) => ({
      id: `a11y-notification-${index}`,
      kind: 'A11Y_TEST_NOTIFICATION',
      title: `${index + 1}. ${longTitle}`,
      body: `${index + 1}. ${longBody}`,
      href: '/staff/knowledge',
      createdAt,
      readAt: createdAt,
    }));
    try {
      for (const enabled of [false, true]) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await setMode(page, enabled);
        await page.setViewportSize({ width: 320, height: 240 });
        const trigger = page.getByRole('button', { name: 'Benachrichtigungen', exact: true });
        await expect(trigger).toBeVisible();
        await trigger.focus();
        await page.keyboard.press('Enter');
        const panel = page.getByRole('dialog', { name: 'Benachrichtigungen', exact: true });
        await expect(panel).toBeVisible();
        await expect(panel).toBeFocused();
        await expectInsideViewport(panel);
        await expect(panel.getByRole('link')).toHaveCount(11);
        expect(await panel.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
          await panel.evaluate((element) => element.clientHeight),
        );

        if (enabled) {
          const title = panel.getByText(`1. ${longTitle}`, { exact: true });
          const body = panel.getByText(`1. ${longBody}`, { exact: true });
          for (const text of [title, body]) {
            const style = await text.evaluate((element) => {
              const computed = getComputedStyle(element);
              return {
                whiteSpace: computed.whiteSpace,
                clamp: computed.webkitLineClamp,
                hiddenHeight: element.scrollHeight - element.clientHeight,
                hiddenWidth: element.scrollWidth - element.clientWidth,
              };
            });
            expect(style.whiteSpace).not.toBe('nowrap');
            expect(style.clamp).toBe('none');
            expect(style.hiddenHeight).toBeLessThanOrEqual(1);
            expect(style.hiddenWidth).toBeLessThanOrEqual(1);
          }
          const time = panel.locator('time').first();
          await expect(time).toHaveAttribute('datetime', createdAt);
          expect(
            await time.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
          ).toBeGreaterThanOrEqual(14);
          await expectNoPanelViolations(page);
        }

        // Reach the footer through native Tab navigation; never click a
        // notification or "Alle gelesen", so fixture ids cause no writes.
        const allNotifications = panel.getByRole('link', { name: 'Alle anzeigen →', exact: true });
        for (
          let attempt = 0;
          attempt < 20 &&
          !(await allNotifications.evaluate((element) => element === document.activeElement));
          attempt += 1
        ) {
          await page.keyboard.press('Tab');
        }
        await expect(allNotifications).toBeFocused();
        await expectInsideViewport(allNotifications);
        await page.keyboard.press('Tab');
        await expect(panel).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Konto-Menü öffnen' })).toBeFocused();

        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(panel).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();

        await page.keyboard.press('Enter');
        await expect(panel).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(panel).toHaveCount(0);
        await expect(trigger).not.toBeFocused();
      }
    } finally {
      await profile.restore();
    }
  });

  test('Toast-Lesefrist pausiert bei Hover und Fokus und entfällt im persönlichen Modus', async ({
    page,
  }) => {
    const profile = await startProfile(page);
    let clockInstalled = false;
    try {
      await setMode(page, false);
      await page.clock.install({ time: new Date() });
      clockInstalled = true;
      // A fresh document creates the actual polling timers under clock control.
      await page.reload({ waitUntil: 'networkidle' });
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      const search = page.getByRole('combobox', { name: 'Globale Suche' });
      const toast = page.getByRole('status').filter({ hasText: 'Neue Benachrichtigung' });

      async function publishThroughPolling(index: number) {
        const timestamp = new Date(Date.now() + 60_000 + index * 1000).toISOString();
        profile.notifications.unread = index;
        profile.notifications.latestUnreadAt = timestamp;
        profile.notifications.items = [
          {
            id: `a11y-toast-${index}`,
            kind: 'A11Y_TEST_NOTIFICATION',
            title: `Testhinweis ${index} mit ausreichend Lesezeit`,
            body: null,
            href: '/staff/knowledge',
            createdAt: timestamp,
            readAt: null,
          },
        ];
        // Focus a real input so the existing typing guard prevents a full route
        // refresh. No synthetic events or calls into application state are used.
        await search.focus();
        await expect
          .poll(
            async () => {
              await page.clock.runFor(1000);
              return toast.isVisible();
            },
            { intervals: [20], timeout: 20_000 },
          )
          .toBe(true);
        await expect(toast).toContainText(`Testhinweis ${index}`);
      }

      await publishThroughPolling(1);
      await toast.hover();
      await page.clock.runFor(9000);
      await expect(toast).toBeVisible();
      await page.mouse.move(0, 0);
      // Exact 7999/8000-ms boundaries are covered by unit tests. Here a
      // deliberate margin also accommodates React flushing the hover update.
      await page.clock.runFor(9000);
      await expect(toast).toHaveCount(0);

      await publishThroughPolling(2);
      const close = toast.getByRole('button', { name: 'Hinweis schließen', exact: true });
      await close.focus();
      await page.clock.runFor(9000);
      await expect(toast).toBeVisible();
      await setMode(page, true);
      await page.clock.runFor(9000);
      await expect(toast).toBeVisible();
      await close.click();
      await expect(toast).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /ungelesene Benachrichtigungen|^Benachrichtigungen$/ }),
      ).toBeFocused();
    } finally {
      if (clockInstalled) await page.clock.resume();
      await profile.restore();
    }
  });
});
