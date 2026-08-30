import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

async function expectNarrowKeyboardControls(page: Page, controls: Locator): Promise<void> {
  await controls.getByRole('combobox').focus();
  for (const label of ['Startspalte', 'Startzeile', 'Breite (Spalten)', 'Höhe (Rasterzeilen)']) {
    await page.keyboard.press('Tab');
    const input = controls.getByRole('spinbutton', { name: label, exact: true });
    await expect(input).toBeFocused();
    await expect(input).toBeInViewport({ ratio: 1 });
  }
  await page.keyboard.press('Tab');
  const apply = controls.getByRole('button', { name: 'Übernehmen', exact: true });
  await expect(apply).toBeFocused();
  await expect(apply).toBeInViewport({ ratio: 1 });
}

test('Dashboard-Layout: Tastatur, Eingabeentwurf, Fehlerstatus und schmale Vorschau', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAsAdmin(page);
  await page.goto('/staff/dashboard', { waitUntil: 'networkidle' });
  let interceptedSaves = 0;
  // Exercise the real save attempt and visible failure without changing the
  // shared development user's personal dashboard layout.
  await page.route('**/staff/dashboard', async (route) => {
    if (route.request().method() === 'POST') {
      interceptedSaves += 1;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  const editButton = page.getByRole('button', { name: 'Anpassen', exact: true });
  await editButton.focus();
  await page.keyboard.press('Enter');
  const controls = page.getByRole('region', { name: 'Position und Größe ohne Ziehen' });
  await expect(controls).toBeVisible();
  const selection = controls.getByLabel('Widget anpassen', { exact: true });
  await selection.focus();
  await page.keyboard.press('Tab');
  const column = controls.getByRole('spinbutton', { name: 'Startspalte', exact: true });
  await expect(column).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(controls.getByRole('spinbutton', { name: 'Startzeile', exact: true })).toBeFocused();

  const width = controls.getByRole('spinbutton', { name: 'Breite (Spalten)', exact: true });
  const originalWidth = await width.inputValue();
  const initialDescription = await controls.getByText(/^Aktuell:/).textContent();
  await width.fill('13');
  await page.keyboard.press('Enter');
  expect(await width.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow)).toBe(
    true,
  );
  expect(interceptedSaves).toBe(0);
  await controls.getByRole('button', { name: 'Eingaben zurücksetzen', exact: true }).click();
  await expect(width).toHaveValue(originalWidth);

  const newWidth = originalWidth === '12' ? Number(await width.getAttribute('min')) : 12;
  await column.fill('1');
  await width.fill(String(newWidth));
  await expect(controls.getByText(/^Aktuell:/)).toHaveText(initialDescription!);
  expect(interceptedSaves).toBe(0);
  const apply = controls.getByRole('button', { name: 'Übernehmen', exact: true });
  await apply.focus();
  await page.keyboard.press('Enter');
  await expect(apply).toBeFocused();
  await expect(controls.getByText(/^Aktuell:/)).toContainText(`Breite ${newWidth}`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Layout konnte nicht gespeichert werden.' }),
  ).toBeVisible();
  await expect(apply).toBeFocused();
  expect(interceptedSaves).toBeGreaterThan(0);

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(
    page.getByText('Bei wenig Platz wird die Vorschau untereinander angezeigt.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.dashboard-edit .react-grid-layout')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        const main = document.querySelector('main')!;
        return Math.max(root.scrollWidth - root.clientWidth, main.scrollWidth - main.clientWidth);
      }),
    )
    .toBeLessThanOrEqual(1);
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('nextjs-portal')
    .analyze();
  expect(
    axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
  ).toEqual([]);
  await expectNarrowKeyboardControls(page, controls);
  await test.info().attach('dashboard-layout-controls-320px.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  const remove = controls.getByRole('button', { name: /^Widget entfernen:/ });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Fertig', exact: true })).toBeFocused();
  // Explicitly navigate away before cleanup, discarding the local draft and
  // its pending debounce. All write requests remained intercepted throughout.
  await page.goto('/staff/profile', { waitUntil: 'networkidle' });
});

test('ACP-Mandantenlayout: benannte Block-Steuerung ohne Ziehen bei 320px', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsAdmin(page);
  await page.goto('/staff/admin/settings/modules', { waitUntil: 'networkidle' });
  let interceptedSaves = 0;
  await page.route('**/staff/admin/settings/modules', async (route) => {
    if (route.request().method() === 'POST') {
      interceptedSaves += 1;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
  const edit = page.getByRole('button', { name: 'Anpassen', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');
  const controls = page.getByRole('region', { name: 'Position und Größe ohne Ziehen' });
  await expect(controls.getByLabel('Block anpassen')).toBeVisible();
  await expect(controls.locator('form')).toHaveAttribute('data-settings-no-track', 'true');
  await expect(controls.getByRole('button', { name: 'Übernehmen', exact: true })).toBeVisible();
  const width = controls.getByRole('spinbutton', { name: 'Breite (Spalten)', exact: true });
  const originalWidth = Number(await width.inputValue());
  const newWidth = originalWidth === 12 ? Number(await width.getAttribute('min')) : 12;
  const initialDescription = await controls.getByText(/^Aktuell:/).textContent();
  await controls.getByRole('spinbutton', { name: 'Startspalte', exact: true }).fill('1');
  await width.fill(String(newWidth));
  await expect(controls.getByText(/^Aktuell:/)).toHaveText(initialDescription!);
  expect(interceptedSaves).toBe(0);
  await expect(page.locator('.settings-pill')).toHaveCount(0);
  const apply = controls.getByRole('button', { name: 'Übernehmen', exact: true });
  await apply.focus();
  await page.keyboard.press('Enter');
  await expect(controls.getByText(/^Aktuell:/)).toContainText(`Breite ${newWidth}`);
  await expect(apply).toBeFocused();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Layout konnte nicht gespeichert werden.' }),
  ).toBeVisible();
  expect(interceptedSaves).toBeGreaterThan(0);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator('.dashboard-edit .react-grid-layout')).toHaveCount(0);
  await expect
    .poll(() => controls.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  const axe = await new AxeBuilder({ page })
    .include('[data-grid-layout-controls]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
  ).toEqual([]);
  await expectNarrowKeyboardControls(page, controls);
  await test.info().attach('client-layout-controls-320px.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.goto('/staff/profile', { waitUntil: 'networkidle' });
});
