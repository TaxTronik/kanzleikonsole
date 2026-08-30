import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { loginAsMandant } from './helpers/portal-auth';

const DISPLAY_LABEL = 'Barrierearmen Anzeigemodus aktivieren';
const STAFF_PROFILE = '/staff/profile';
const PORTAL_SETTINGS = '/portal/settings';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface DisplayOptions {
  fontSize: string;
  spacing: string;
  contrast: string;
  reduceMotion: boolean;
}

async function readOptions(page: Page): Promise<DisplayOptions> {
  const marker = page.locator('[data-accessible-display]');
  return {
    fontSize: (await marker.getAttribute('data-accessible-font-size'))!,
    spacing: (await marker.getAttribute('data-accessible-spacing'))!,
    contrast: (await marker.getAttribute('data-accessible-contrast'))!,
    reduceMotion: (await marker.getAttribute('data-accessible-reduce-motion')) === 'true',
  };
}

async function setOptions(page: Page, options: DisplayOptions): Promise<void> {
  const details = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Anzeige individuell anpassen' }) });
  if (!(await details.getAttribute('open'))) {
    // Ein natives details besitzt im offenen Zustand open="".
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
      await details.locator('summary').click();
  }
  for (const [label, value] of [
    ['Schriftgröße', options.fontSize],
    ['Zeilenabstand', options.spacing],
    ['Kontrast', options.contrast],
  ] as const) {
    const select = details.getByRole('combobox', { name: label, exact: true });
    if ((await select.inputValue()) !== value) {
      await select.selectOption(value);
      await expectSaved(page, await displayCheckbox(page).isChecked());
    }
    await expect(select).toHaveValue(value);
  }
  const motion = details.getByRole('checkbox', { name: 'Bewegung reduzieren', exact: true });
  if ((await motion.isChecked()) !== options.reduceMotion) {
    await motion.setChecked(options.reduceMotion);
    await expectSaved(page, await displayCheckbox(page).isChecked());
  }
}

function displayCheckbox(page: Page) {
  return page.getByRole('checkbox', { name: DISPLAY_LABEL, exact: true });
}

async function expectDisplayMode(page: Page, enabled: boolean): Promise<void> {
  await expect(page.locator('body [data-accessible-display]')).toHaveAttribute(
    'data-accessible-display',
    String(enabled),
  );
}

async function expectSaved(page: Page, enabled: boolean): Promise<void> {
  await expect(
    page.getByRole('status').filter({ hasText: /^Anzeigeeinstellung gespeichert\.$/ }),
  ).toBeVisible();
  await expect(displayCheckbox(page)).toBeEnabled();
  await expect(displayCheckbox(page)).toBeChecked({ checked: enabled });
  await expectDisplayMode(page, enabled);
}

async function setDisplayMode(page: Page, enabled: boolean): Promise<void> {
  const checkbox = displayCheckbox(page);
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toBeEnabled();
  if ((await checkbox.isChecked()) !== enabled) {
    await checkbox.setChecked(enabled);
    await expectSaved(page, enabled);
  }
  await expectDisplayMode(page, enabled);
}

async function expectServerRenderedMode(page: Page, path: string, enabled: boolean): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.ok(), `${path}: Dokument muss erfolgreich ausgeliefert werden`).toBe(true);
  const html = await response!.text();
  // Nur ein echtes HTML-Attribut zählt, kein Wert in einem Hydration-Script.
  const hasServerMarker = new RegExp(
    `<[^>]+\\bdata-accessible-display="${String(enabled)}"(?:\\s|>)`,
  ).test(html);
  expect(hasServerMarker, `${path}: Anzeigeprofil muss bereits im Server-HTML stehen`).toBe(true);
  await expectDisplayMode(page, enabled);
}

async function restoreStaffMode(page: Page, original: boolean): Promise<void> {
  await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
  // Der reguläre Logout widerruft alle Staff-Sessions; auch im Fehlerfall
  // darf deshalb ein frischer Seed-Login für die Wiederherstellung nötig sein.
  if (new URL(page.url()).pathname === '/staff/login') {
    await loginAsAdmin(page);
    await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
  }
  await setDisplayMode(page, original);
}

async function restorePortalMode(
  page: Page,
  request: APIRequestContext,
  original: boolean,
): Promise<void> {
  await page.goto(PORTAL_SETTINGS, { waitUntil: 'networkidle' });
  if (new URL(page.url()).pathname === '/portal/login') {
    await loginAsMandant(page, request);
    await page.goto(PORTAL_SETTINGS, { waitUntil: 'networkidle' });
  }
  await setDisplayMode(page, original);
}

async function selectTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const currentName =
    theme === 'dark' ? 'Dunkel — klicken für System' : 'Hell — klicken für Dunkel';
  const toggle = page.getByRole('button', { name: /^(Dunkel|Hell|System) — klicken für / });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-label')) === currentName) break;
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-label', currentName);
  if (theme === 'dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
}

async function expectNoWcagViolations(page: Page, context: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // Das Next.js-Entwicklerportal gehört nicht zur ausgelieferten Anwendung.
    .exclude('nextjs-portal')
    .analyze();
  await test.info().attach(`axe-${context}.json`, {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json',
  });
  const summary = result.violations
    .map((violation) => {
      const targets = violation.nodes.flatMap((node) => node.target.map(String)).join(', ');
      return `[${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help} (${targets})`;
    })
    .join('\n');
  expect(result.violations, `${context}\n${summary}`).toEqual([]);
}

async function expectNoPageOverflow(page: Page, context: string): Promise<void> {
  // ResizeObserver/RGL übernimmt neue Breiten asynchron. Auf das sichtbare
  // Ergebnis warten, nicht unmittelbar nach setViewportSize alte Maße prüfen.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const root = document.documentElement;
          const main = document.querySelector('main')!;
          return Math.max(root.scrollWidth - root.clientWidth, main.scrollWidth - main.clientWidth);
        }),
      { message: `${context}: weder Dokument noch Hauptinhalt seitlich abschneiden` },
    )
    .toBeLessThanOrEqual(1);
}

async function expectCenteredAvatar(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Konto-Menü öffnen' });
  await expect(trigger).toBeVisible();
  const geometry = await trigger.evaluate((button) => {
    const target = button.getBoundingClientRect();
    const avatar = button.querySelector('.avatar')!.getBoundingClientRect();
    return {
      width: target.width,
      height: target.height,
      display: getComputedStyle(button).display,
      alignItems: getComputedStyle(button).alignItems,
      justifyContent: getComputedStyle(button).justifyContent,
      dx: Math.abs(target.x + target.width / 2 - (avatar.x + avatar.width / 2)),
      dy: Math.abs(target.y + target.height / 2 - (avatar.y + avatar.height / 2)),
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(
    geometry.dx,
    `Avatar horizontal in der Klickfläche zentrieren: ${JSON.stringify(geometry)}`,
  ).toBeLessThanOrEqual(1);
  expect(geometry.dy, 'Avatar vertikal in der Klickfläche zentrieren').toBeLessThanOrEqual(1);
}

async function expectShortViewportMenu(page: Page, context: string): Promise<void> {
  await page.setViewportSize({ width: 320, height: 240 });
  await expectCenteredAvatar(page);
  const trigger = page.getByRole('button', { name: 'Konto-Menü öffnen' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect
    .poll(async () =>
      menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return Math.max(-rect.top, rect.bottom - window.innerHeight);
      }),
    )
    .toBeLessThanOrEqual(1);
  const scrollable = await menu.evaluate((element) => ({
    content: element.scrollHeight,
    visible: element.clientHeight,
  }));
  expect(scrollable.content, 'Alle vergrößerten Menüeinträge scrollbar anbieten').toBeGreaterThan(
    scrollable.visible,
  );
  await page.keyboard.press('End');
  const lastItem = menu.getByRole('menuitem', { name: 'Abmelden', exact: true });
  await expect(lastItem).toBeFocused();
  const lastItemBounds = await lastItem.boundingBox();
  const menuBounds = await menu.boundingBox();
  expect(lastItemBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  expect(lastItemBounds!.y).toBeGreaterThanOrEqual(menuBounds!.y);
  expect(lastItemBounds!.y + lastItemBounds!.height).toBeLessThanOrEqual(
    menuBounds!.y + menuBounds!.height + 1,
  );
  await expectNoWcagViolations(page, context);
  await test.info().attach(`${context}.png`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(lastItem).toBeFocused();
  // Nicht ausloggen: nur den letzten Eintrag erreichen und Fokus zurückgeben.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function expectMenuTabExit(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Konto-Menü öffnen' });
  for (const key of ['Tab', 'Shift+Tab']) {
    // Die erwartete Reihenfolge aus der echten Seite bestimmen, nicht mit
    // einer zweiten Implementierung der Tabziel-Suche im Test nachbauen.
    await trigger.focus();
    await page.keyboard.press(key);
    const expectedTarget = await page.evaluateHandle(() => document.activeElement);
    try {
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press(key);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect
        .poll(() => page.evaluate((element) => element === document.activeElement, expectedTarget))
        .toBe(true);
    } finally {
      await expectedTarget.dispose();
    }
  }
}

test.describe('Persönlicher barrierearmer Anzeigemodus', () => {
  // Die Dev-Seed-Konten werden geteilt. Jeder Test stellt seinen ursprünglichen
  // Profilwert wieder her; kein Test setzt einen bestimmten Ausgangswert voraus.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('Tastatur, Server-Rendering, neues Browserprofil und Logout', async ({
    page,
    browser,
    baseURL,
  }) => {
    await loginAsAdmin(page);
    await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
    const original = await displayCheckbox(page).isChecked();

    try {
      await setDisplayMode(page, false);
      await displayCheckbox(page).focus();
      await expect(displayCheckbox(page)).toBeFocused();
      await page.keyboard.press('Space');
      await expectSaved(page, true);
      await expect(displayCheckbox(page)).toBeFocused();

      await page.reload({ waitUntil: 'networkidle' });
      await expect(displayCheckbox(page)).toBeChecked();
      await expectServerRenderedMode(page, STAFF_PROFILE, true);

      // Keine kopierten Cookies, kein storageState, kein localStorage: Ein
      // frischer Browserkontext muss nach dem Login denselben DB-Wert erhalten.
      const freshContext = await browser.newContext({ baseURL });
      try {
        const freshPage = await freshContext.newPage();
        await loginAsAdmin(freshPage);
        await expectServerRenderedMode(freshPage, STAFF_PROFILE, true);
        await expect(displayCheckbox(freshPage)).toBeChecked();
      } finally {
        await freshContext.close();
      }

      await setDisplayMode(page, false);
      await expectServerRenderedMode(page, STAFF_PROFILE, false);
      await expect(displayCheckbox(page)).not.toBeChecked();

      // Verbindungsfehler dürfen weder Erfolg behaupten noch den Fokus oder
      // den gespeicherten Serverstand verlieren. Nur diese Anzeige-Action abbrechen.
      await page.route('**/staff/profile', async (route) => {
        if (route.request().method() === 'POST') await route.abort('failed');
        else await route.continue();
      });
      try {
        await displayCheckbox(page).focus();
        await page.keyboard.press('Space');
        await expect(
          page
            .getByRole('region', { name: 'Barrierearmer Anzeigemodus', exact: true })
            .getByRole('alert'),
        ).toContainText('konnte nicht gespeichert werden');
        await expect(displayCheckbox(page)).toBeFocused();
        await expect(displayCheckbox(page)).not.toBeChecked();
        await expectDisplayMode(page, false);
      } finally {
        await page.unroute('**/staff/profile');
      }

      await setDisplayMode(page, true);
      await page.getByRole('button', { name: 'Konto-Menü öffnen' }).click();
      await page.getByRole('menuitem', { name: 'Abmelden', exact: true }).click();
      await expect(page).toHaveURL(/\/staff\/login(?:\?|$)/);
      await expect(page.locator('[data-accessible-display="true"]')).toHaveCount(0);
    } finally {
      await restoreStaffMode(page, original);
    }
  });

  test('Profil und Dashboard sind mit größerer Anzeige hell, dunkel und schmal nutzbar', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
    const original = await displayCheckbox(page).isChecked();

    try {
      await setDisplayMode(page, true);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      // Der persönliche Modus behält Vorrang vor Glas/Animationen der Modern-Ansicht.
      await page.getByRole('button', { name: /Klassisches UI — klicken für Modern/ }).click();
      await expect(page.locator('html')).toHaveClass(/ui-modern/);
      for (const theme of ['light', 'dark'] as const) {
        await selectTheme(page, theme);
        for (const [name, path] of [
          ['profile', STAFF_PROFILE],
          ['dashboard', '/staff/dashboard'],
        ] as const) {
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.goto(path, { waitUntil: 'networkidle' });
          await expectDisplayMode(page, true);
          await expectCenteredAvatar(page);
          await expectNoWcagViolations(page, `accessible-${name}-${theme}`);
          await test.info().attach(`accessible-${name}-${theme}.png`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          });

          await page.setViewportSize({ width: 320, height: 800 });
          await expectNoPageOverflow(page, `accessible-${name}-${theme}-320`);
          await expectCenteredAvatar(page);
          if (name === 'dashboard') {
            const widgetWidths = await page
              .locator('.react-grid-item:has(> .widget-shell)')
              .evaluateAll((widgets) =>
                widgets.map((widget) => ({
                  width: widget.getBoundingClientRect().width,
                  containerWidth: widget.parentElement!.getBoundingClientRect().width,
                })),
              );
            expect(widgetWidths.length).toBeGreaterThan(0);
            for (const widget of widgetWidths)
              expect(widget.width).toBeGreaterThanOrEqual(widget.containerWidth - 2);
          }
          await test.info().attach(`accessible-${name}-${theme}-320.png`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          });
        }
      }
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
      await restoreStaffMode(page, original);
    }
  });

  test('Portalprofil speichert unabhängig vom Staffprofil im selben Browser', async ({
    page,
    request,
  }) => {
    await loginAsAdmin(page);
    await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
    const staffOriginal = await displayCheckbox(page).isChecked();
    let portalOriginal: boolean | undefined;

    try {
      await setDisplayMode(page, false);
      await loginAsMandant(page, request);
      await page.goto(PORTAL_SETTINGS, { waitUntil: 'networkidle' });
      portalOriginal = await displayCheckbox(page).isChecked();
      await setDisplayMode(page, true);

      await page.reload({ waitUntil: 'networkidle' });
      await expect(displayCheckbox(page)).toBeChecked();
      await expectServerRenderedMode(page, PORTAL_SETTINGS, true);
      await expectNoWcagViolations(page, 'accessible-portal-settings');
      await page.setViewportSize({ width: 320, height: 800 });
      await expectNoPageOverflow(page, 'accessible-portal-settings-320');
      await page.setViewportSize({ width: 1280, height: 900 });

      await expectServerRenderedMode(page, STAFF_PROFILE, false);
      await expect(displayCheckbox(page)).not.toBeChecked();
      await setDisplayMode(page, true);

      await page.goto(PORTAL_SETTINGS, { waitUntil: 'networkidle' });
      await setDisplayMode(page, false);
      await expectServerRenderedMode(page, PORTAL_SETTINGS, false);
      await expectServerRenderedMode(page, STAFF_PROFILE, true);
      await expect(displayCheckbox(page)).toBeChecked();
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
      try {
        if (portalOriginal !== undefined) {
          await restorePortalMode(page, request, portalOriginal);
        }
      } finally {
        await restoreStaffMode(page, staffOriginal);
      }
    }
  });

  test('Konto-Menü bleibt bei geringer Höhe in Staff und Portal per Tastatur erreichbar', async ({
    page,
    request,
  }) => {
    await loginAsAdmin(page);
    await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
    const staffOriginal = await displayCheckbox(page).isChecked();
    let portalOriginal: boolean | undefined;

    try {
      await setDisplayMode(page, false);
      await expectMenuTabExit(page);
      await setDisplayMode(page, true);
      for (const theme of ['light', 'dark'] as const) {
        await selectTheme(page, theme);
        await expectShortViewportMenu(page, `accessible-staff-menu-${theme}-320x240`);
        await expectMenuTabExit(page);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await loginAsMandant(page, request);
      await page.goto(PORTAL_SETTINGS, { waitUntil: 'networkidle' });
      portalOriginal = await displayCheckbox(page).isChecked();
      await setDisplayMode(page, true);
      await expectShortViewportMenu(page, 'accessible-portal-menu-320x240');
      await expectMenuTabExit(page);
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
      try {
        if (portalOriginal !== undefined) {
          await restorePortalMode(page, request, portalOriginal);
        }
      } finally {
        await restoreStaffMode(page, staffOriginal);
      }
    }
  });

  test('Individuelle Anzeigeoptionen bleiben profilgebunden gespeichert und bei Speicherfehlern erhalten', async ({
    page,
    request,
  }) => {
    await loginAsAdmin(page);
    await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
    const staffMode = await displayCheckbox(page).isChecked();
    const staffOptions = await readOptions(page);
    let portalMode: boolean | undefined;
    let portalOptions: DisplayOptions | undefined;
    const custom = {
      fontSize: 'extra-large',
      spacing: 'wide',
      contrast: 'standard',
      reduceMotion: false,
    };
    try {
      await setDisplayMode(page, true);
      await setOptions(page, custom);
      await page.reload({ waitUntil: 'networkidle' });
      expect(await readOptions(page)).toEqual(custom);
      expect(
        await page.locator('html').evaluate((element) => getComputedStyle(element).fontSize),
      ).toBe('20px');
      expect(
        await page.locator('body').evaluate((element) => getComputedStyle(element).lineHeight),
      ).toBe('36px');
      await page.setViewportSize({ width: 320, height: 800 });
      await expectNoPageOverflow(page, 'custom-options-320');
      await expectNoWcagViolations(page, 'custom-options-320');
      await page.setViewportSize({ width: 1280, height: 900 });

      // Optionen überleben auch das Ausschalten des übergeordneten Modus.
      await setDisplayMode(page, false);
      await page.reload({ waitUntil: 'networkidle' });
      expect(await readOptions(page)).toEqual(custom);
      expect(
        await page.locator('html').evaluate((element) => getComputedStyle(element).fontSize),
      ).toBe('16px');
      await setDisplayMode(page, true);
      await setOptions(page, custom);
      const font = page.getByRole('combobox', { name: 'Schriftgröße', exact: true });
      await page.route('**/staff/profile', async (route) =>
        route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
      );
      try {
        await font.focus();
        await font.selectOption('standard');
        await expect(
          page
            .getByRole('region', { name: 'Barrierearmer Anzeigemodus', exact: true })
            .getByRole('alert'),
        ).toContainText('konnten nicht gespeichert werden');
        await expect(font).toHaveValue('extra-large');
        await expect(font).toBeFocused();
        expect(await readOptions(page)).toEqual(custom);
      } finally {
        await page.unroute('**/staff/profile');
      }

      await loginAsMandant(page, request);
      await page.goto(PORTAL_SETTINGS, { waitUntil: 'networkidle' });
      portalMode = await displayCheckbox(page).isChecked();
      portalOptions = await readOptions(page);
      const portalCustom = {
        fontSize: 'standard',
        spacing: 'normal',
        contrast: 'strong',
        reduceMotion: true,
      };
      await setDisplayMode(page, true);
      await setOptions(page, portalCustom);
      await page.reload({ waitUntil: 'networkidle' });
      expect(await readOptions(page)).toEqual(portalCustom);
      await page.goto(STAFF_PROFILE, { waitUntil: 'networkidle' });
      expect(await readOptions(page)).toEqual(custom);
      await setOptions(page, custom);
      await page
        .getByRole('button', { name: 'Empfohlene Anzeige wiederherstellen', exact: true })
        .click();
      await expectSaved(page, true);
      expect(await readOptions(page)).toEqual({
        fontSize: 'large',
        spacing: 'relaxed',
        contrast: 'strong',
        reduceMotion: true,
      });
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
      try {
        if (portalOptions && portalMode !== undefined) {
          await restorePortalMode(page, request, portalMode);
          await setOptions(page, portalOptions);
        }
      } finally {
        await restoreStaffMode(page, staffMode);
        await setOptions(page, staffOptions);
      }
    }
  });
});
