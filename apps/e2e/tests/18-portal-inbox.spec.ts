// Fachkatalog: PORTAL-INBOX-SUBMISSION-001.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { loginAsMandant } from './helpers/portal-auth';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoWcagViolations(page: Page, context: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // Das Next.js-Dev-Tools-Portal gehoert nicht zur ausgelieferten Anwendung.
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
    `${context}: Die Seite ist ${dimensions.scrollWidth - dimensions.clientWidth}px breiter als der Viewport.`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectMobileNavigationEntry(page: Page, label: string): Promise<void> {
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
  await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-label', 'Menü öffnen');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
}

function portalThreadLink(page: Page, subject: string) {
  return page
    .getByRole('region', { name: 'Nachrichtenverläufe' })
    .getByRole('link')
    .filter({ hasText: subject });
}

function staffThreadLink(page: Page, subject: string) {
  return page
    .getByRole('region', { name: 'Mandantenpost-Verläufe' })
    .getByRole('link')
    .filter({ hasText: subject });
}

test.describe('Sicherer Mandantenposteingang', () => {
  test('Portal-Erstellung und Staff-Arbeitskörbe sind sichtbar, responsiv und zugänglich', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const subject = `E2E Mandantenpost ${Date.now()}`;
    const message = `Automatisierter Portal-Nachweis ${Date.now()}`;

    await loginAsMandant(page, request);

    // Der Seed aktiviert clientInbox nur fuer den synthetischen Testtenant.
    await expect(page.getByRole('link', { name: 'Nachrichten', exact: true })).toBeVisible();
    await page.goto('/portal/inbox', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Nachrichten', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nachricht an Kanzlei' })).toBeVisible();

    await page.getByRole('link', { name: 'Nachricht an Kanzlei' }).click();
    await expect(page).toHaveURL(/\/portal\/inbox\/new$/);
    await expect(page.getByRole('heading', { name: 'Nachricht an Kanzlei' })).toBeVisible();
    await expect(
      page.getByText(/alle aktiven Portal-Kontakte dieses Mandanten/i),
      'Der mandantenweite Shared-Contact-Sichtbarkeitshinweis muss vor dem Absenden sichtbar sein.',
    ).toBeVisible();
    await expect(page.getByText(/setzt keine Frist.*fachliche Annahme/i)).toBeVisible();
    await expectNoWcagViolations(page, 'portal-inbox-new');

    await page.getByLabel('Betreff').fill(subject);
    await page.getByLabel('Nachricht').fill(message);
    // Ohne Anlage bleibt dieser fachliche UI-Flow unabhaengig von ClamAV/S3.
    await page.getByRole('button', { name: 'Nachricht senden' }).click();
    await expect(page).toHaveURL(/\/portal\/inbox\/[0-9a-f-]+$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: subject, exact: true })).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toBeVisible();

    await page.goto('/portal/inbox', { waitUntil: 'networkidle' });
    await expect(portalThreadLink(page, subject)).toBeVisible();

    await page.setViewportSize({ width: 320, height: 800 });
    await expectNoPageOverflow(page, 'portal-inbox-320');
    await expectNoWcagViolations(page, 'portal-inbox-320');
    await expectMobileNavigationEntry(page, 'Nachrichten');

    const staffPage = await page.context().newPage();
    try {
      await loginAsAdmin(staffPage);
      await staffPage.goto('/staff/inbox', { waitUntil: 'networkidle' });
      await expect(staffPage.getByRole('heading', { name: 'Mandantenpost' })).toBeVisible();

      const workNavigation = staffPage.getByRole('navigation', { name: 'Arbeitsbereich' });
      await expect(workNavigation.getByRole('link', { name: 'Meine Arbeit' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(staffThreadLink(staffPage, subject)).toBeVisible();

      await workNavigation.getByRole('link', { name: 'Team' }).click();
      await expect(staffPage).toHaveURL(/\/staff\/inbox\?scope=team$/);
      await expect(staffThreadLink(staffPage, subject)).toHaveCount(0);

      // Der Dev-Seed routet genau einen Hauptbearbeiter automatisch. Fuer den
      // Teamkorb wird derselbe Verlauf explizit freigegeben und danach geclaimt.
      await staffPage.goto('/staff/inbox', { waitUntil: 'networkidle' });
      await staffThreadLink(staffPage, subject).click();
      await expect(staffPage.getByRole('heading', { name: subject, exact: true })).toBeVisible();
      await staffPage.getByLabel('Zuweisung').selectOption({ label: 'Teamkorb' });
      await staffPage.getByRole('button', { name: 'Zuweisen' }).click();
      await expect(staffPage.getByRole('button', { name: 'Übernehmen' })).toBeVisible();

      await staffPage.goto('/staff/inbox', { waitUntil: 'networkidle' });
      await expect(staffThreadLink(staffPage, subject)).toHaveCount(0);
      await staffPage.goto('/staff/inbox?scope=team', { waitUntil: 'networkidle' });
      await staffThreadLink(staffPage, subject).click();
      await staffPage.getByRole('button', { name: 'Übernehmen' }).click();
      await expect(staffPage.getByRole('button', { name: 'Übernehmen' })).toHaveCount(0);

      await staffPage.goto('/staff/inbox', { waitUntil: 'networkidle' });
      await expect(staffThreadLink(staffPage, subject)).toBeVisible();
      await staffPage
        .getByRole('navigation', { name: 'Arbeitsbereich' })
        .getByRole('link', { name: 'Team' })
        .click();
      await expect(staffPage).toHaveURL(/\/staff\/inbox\?scope=team$/);
      await expect(staffThreadLink(staffPage, subject)).toHaveCount(0);

      await staffPage.setViewportSize({ width: 320, height: 800 });
      await staffPage
        .getByRole('navigation', { name: 'Arbeitsbereich' })
        .getByRole('link', { name: 'Meine Arbeit' })
        .click();
      await expect(staffPage).toHaveURL(/\/staff\/inbox$/);
      await expectNoPageOverflow(staffPage, 'staff-inbox-320');
      await expectNoWcagViolations(staffPage, 'staff-inbox-320');
      await expectMobileNavigationEntry(staffPage, 'Mandantenpost');
    } finally {
      await staffPage.close();
    }
  });
});
