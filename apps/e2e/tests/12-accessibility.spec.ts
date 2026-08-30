import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { loginAsMandant } from './helpers/portal-auth';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoWcagViolations(page: Page, context: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // Next.js' Dev-Tools-Portal gehört nicht zur ausgelieferten Anwendung.
    .exclude('nextjs-portal')
    .analyze();

  await test.info().attach(`axe-${context}.json`, {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json',
  });

  const summary = result.violations
    .map((violation) => {
      const targets = violation.nodes
        .flatMap((node) => node.target.map((target) => String(target)))
        .join(', ');
      return `[${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help} (${targets})`;
    })
    .join('\n');

  expect(result.violations, `${context}\n${summary}`).toEqual([]);
}

async function expectNoPageOverflow(page: Page, context: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${context}: Die Seite ist ${dimensions.scrollWidth - dimensions.clientWidth}px breiter als der Viewport. ` +
      'Breite Datentabellen dürfen intern scrollen, die Dokumentwurzel nicht.',
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test.describe('Barrierefreiheit — WCAG 2.2 AA Baseline', () => {
  test('öffentliche Login-Seiten enthalten keine automatisiert erkennbaren Verstöße', async ({
    page,
  }) => {
    await page.goto('/staff/login', { waitUntil: 'networkidle' });
    await expectNoWcagViolations(page, 'staff-login');

    await page.goto('/portal/login', { waitUntil: 'networkidle' });
    await expectNoWcagViolations(page, 'portal-login');
  });

  test('zentrale Staff-Seiten enthalten keine automatisiert erkennbaren Verstöße', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    for (const [name, path] of [
      ['dashboard', '/staff/dashboard'],
      ['clients', '/staff/clients'],
      ['documents', '/staff/documents'],
      ['requests', '/staff/requests'],
      ['invoices', '/staff/invoices'],
      ['calendar', '/staff/calendar'],
      ['forms', '/staff/forms'],
      ['workflows', '/staff/workflows'],
      ['knowledge', '/staff/knowledge'],
      ['admin', '/staff/admin'],
      ['admin-users', '/staff/admin/users'],
      ['admin-settings', '/staff/admin/settings'],
    ] as const) {
      await page.goto(path, { waitUntil: 'networkidle' });
      await expectNoWcagViolations(page, name);
    }

    await page.goto('/staff/clients', { waitUntil: 'networkidle' });
    await page
      .getByRole('link', { name: /Mustermann GmbH/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/staff\/clients\/[^/]+/);
    const clientPath = new URL(page.url()).pathname.replace(/\/$/, '');
    await page.goto(`${clientPath}/gwg`, { waitUntil: 'networkidle' });
    await expectNoWcagViolations(page, 'gwg');
  });

  test('zentrale Portal-Seiten enthalten keine automatisiert erkennbaren Verstöße', async ({
    page,
    request,
  }) => {
    await loginAsMandant(page, request);
    for (const [name, path] of [
      ['portal-dashboard', '/portal/dashboard'],
      ['portal-appointments', '/portal/appointments'],
      ['portal-documents', '/portal/documents'],
      ['portal-requests', '/portal/requests'],
      ['portal-invoices', '/portal/invoices'],
      ['portal-forms', '/portal/forms'],
      ['portal-settings', '/portal/settings'],
      ['portal-stammdaten', '/portal/stammdaten'],
    ] as const) {
      await page.goto(path, { waitUntil: 'networkidle' });
      await expectNoWcagViolations(page, name);
    }
  });

  test('Login und Dashboard bestehen die Axe-Prüfung auch im Dark Mode', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/staff/login', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expectNoWcagViolations(page, 'staff-login-dark');

    await loginAsAdmin(page);
    await expect(page.locator('html')).toHaveClass(/dark/);
    for (const [name, path] of [
      ['dashboard-dark', '/staff/dashboard'],
      ['knowledge-dark', '/staff/knowledge'],
      ['admin-settings-dark', '/staff/admin/settings'],
    ] as const) {
      await page.goto(path, { waitUntil: 'networkidle' });
      await expectNoWcagViolations(page, name);
    }
  });

  test('Kernseiten erzeugen bei 320 CSS-Pixeln keinen Seiten-Horizontal-Scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/staff/login', { waitUntil: 'networkidle' });
    await expectNoPageOverflow(page, 'staff-login-320');

    await loginAsAdmin(page);
    for (const [name, path] of [
      ['dashboard-320', '/staff/dashboard'],
      ['knowledge-320', '/staff/knowledge'],
    ] as const) {
      await page.goto(path, { waitUntil: 'networkidle' });
      await expectNoPageOverflow(page, name);
    }
  });

  test('Skip-Link erreicht den Hauptinhalt per Tastatur', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/dashboard', { waitUntil: 'networkidle' });

    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: /zum hauptinhalt/i });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main-content')).toBeFocused();
  });

  test('mobile Navigation meldet und verwaltet ihren Zustand', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsAdmin(page);
    await page.goto('/staff/dashboard', { waitUntil: 'networkidle' });

    const menuButton = page.locator('button[aria-controls="app-sidebar"]');
    await expect(menuButton).toHaveAttribute('aria-label', 'Menü öffnen');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await expect(menuButton).toHaveAttribute('aria-label', 'Menü schließen');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('aside.app-sidebar')).toBeVisible();
    await expect(page.locator('aside.app-sidebar')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('aside.app-sidebar')).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('button', { name: 'Menü schließen', exact: true })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menuButton).toBeFocused();
    await expect(menuButton).toHaveAttribute('aria-label', 'Menü öffnen');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  });
});
