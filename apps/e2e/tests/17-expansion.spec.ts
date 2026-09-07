// Fachkatalog: ACCESS-TENANT-RLS-001, PAYROLL-INTAKE-001, MAIL-INBOX-001,
// FORM-SCHEMA-SNAPSHOT-001, MANDATE-STRUCTURE-001, CLIENT-ASSISTANCE-001,
// WORKFLOW-DEPENDENCY-001.
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

test.describe('isolated opt-in expansion browser integration', () => {
  test.setTimeout(180_000);
  test('anonymous requests cannot download payroll, assistance or mailbox files', async ({
    request,
    page,
  }) => {
    const id = '11111111-1111-4111-8111-111111111111';
    for (const path of [
      `/api/staff/mailbox/attachments/${id}`,
      `/api/staff/payroll/${id}/attachments/${id}`,
      `/api/portal/payroll/${id}/attachments/${id}`,
    ]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([401, 403]).toContain(response.status());
    }
    await page.goto('/payroll/employee');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByText('Mustermann GmbH', { exact: true })).toHaveCount(0);
  });
  test('staff can open every enabled expansion workspace without runtime errors', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const paths = [
      '/staff/knowledge/context',
      '/staff/year-end',
      '/staff/interactions',
      '/staff/mailbox',
      '/staff/payroll',
      '/staff/client-assistance',
      '/staff/mandate-expansion/structure',
      '/staff/mandate-expansion/dependencies',
      '/staff/mandate-expansion/offboarding',
      '/staff/mandate-expansion/vdb',
      '/staff/admin/screening',
      '/staff/stbvv',
    ];
    for (const path of paths) {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), path).toBeLessThan(400);
      await expect(page).toHaveURL(
        new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\?.*)?$'),
      );
      await expect(page.locator('h1').first(), path).toBeVisible();
      await expect(page.getByText(/Application error:|Internal Server Error/)).toHaveCount(0);
    }
  });
  test('a personal invitation grants only its own employee draft and revocation ends that session', async ({
    page,
    browser,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/payroll');
    await page.getByText('Neuen Personalvorgang vorbereiten', { exact: true }).click();
    await page
      .getByRole('combobox', { name: /^Mandat/ })
      .selectOption({ label: 'Mustermann GmbH' });
    await page
      .getByLabel('Ausdrücklich berechtigter Arbeitgeberkontakt')
      .selectOption({ label: 'Mustermann GmbH: Max Mustermann' });
    const label = 'Browsertest Personal ' + Date.now();
    await page.getByLabel('Bezeichnung der Person').fill(label);
    await page
      .getByLabel('Abgabe-/Zugriffsende')
      .fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Einzelvorgang anlegen' }).click();
    await page.getByRole('link', { name: 'Ergebnis öffnen' }).click();
    await expect(page.getByRole('heading', { name: label })).toBeVisible();
    await page
      .getByRole('button', { name: 'Neuen persönlichen Arbeitnehmerlink erstellen' })
      .click();
    const link = await page
      .getByRole('link', { name: 'Persönlicher Arbeitnehmerlink (vertraulich weitergeben)' })
      .getAttribute('href');
    expect(link).toContain('#invite=');
    const guest = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const personal = await guest.newPage();
      await personal.goto(link!);
      await personal.getByRole('button', { name: 'Persönlichen Vorgang öffnen' }).click();
      await expect(personal.getByLabel('Vorname', { exact: false })).toBeVisible();
      expect((await guest.cookies()).some((c) => c.name.includes('staff_session'))).toBe(false);
      await expect(
        personal.getByLabel('Vereinbarte Bruttovergütung in EUR', { exact: false }),
      ).toHaveCount(0);
      await personal.getByLabel('Vorname', { exact: false }).fill('Synthetischer Name');
      await personal.getByRole('button', { name: 'Auswahl speichern' }).click();
      await expect(personal.getByRole('status').filter({ hasText: 'Gespeichert.' })).toBeVisible();
      await personal.reload();
      await expect(personal.getByLabel('Vorname', { exact: false })).toHaveValue(
        'Synthetischer Name',
      );
      await page
        .getByRole('button', { name: 'Neuen persönlichen Arbeitnehmerlink erstellen' })
        .click();
      await expect(
        page.getByRole('link', { name: 'Persönlicher Arbeitnehmerlink (vertraulich weitergeben)' }),
      ).not.toHaveAttribute('href', link!);
      await personal.reload();
      await expect(personal.getByLabel('Vorname', { exact: false })).toHaveCount(0);
    } finally {
      await guest.close();
    }
  });
  test('dependencies require explicit matching years before they can be connected', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/mandate-expansion/dependencies');
    await page.getByRole('combobox', { name: 'Vorleistung', exact: true }).selectOption({
      label: 'Abhängigkeit Quelle · Veranlagung Quelle · Jahr unbestätigt · Prüfung Quelle',
    });
    await page.getByRole('combobox', { name: 'Abhängiger Schritt', exact: true }).selectOption({
      label: 'Abhängigkeit Ziel · Veranlagung Ziel · Jahr unbestätigt · Prüfung Ziel',
    });
    await page.getByRole('button', { name: 'Abhängigkeit hinzufügen', exact: true }).click();
    await expect(
      page.getByText(
        'Beide Workflowvorgänge müssen ausdrücklich demselben Veranlagungsjahr zugeordnet sein.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByText('Veranlagungsjahre bestätigen', { exact: true }).click();
    for (const name of ['Quelle', 'Ziel']) {
      const form = page
        .locator('form')
        .filter({ hasText: `Abhängigkeit ${name} · Veranlagung ${name}` })
        .filter({ has: page.getByRole('button', { name: 'Jahr bestätigen', exact: true }) });
      await form.locator('input[name="year"]').fill('2026');
      await form.getByRole('button', { name: 'Jahr bestätigen', exact: true }).click();
      await expect(form.getByRole('status')).toContainText('Gespeichert');
    }
    await page
      .getByRole('combobox', { name: 'Vorleistung', exact: true })
      .selectOption({ label: 'Abhängigkeit Quelle · Veranlagung Quelle · 2026 · Prüfung Quelle' });
    await page
      .getByRole('combobox', { name: 'Abhängiger Schritt', exact: true })
      .selectOption({ label: 'Abhängigkeit Ziel · Veranlagung Ziel · 2026 · Prüfung Ziel' });
    await page.getByRole('button', { name: 'Abhängigkeit hinzufügen', exact: true }).click();
    const target = page.locator('section').filter({
      has: page.getByRole('heading', {
        name: 'Abhängigkeit Ziel · Veranlagung Ziel · 2026 · Prüfung Ziel',
        level: 3,
        exact: true,
      }),
    });
    await expect(target.getByText('Wartet auf Vorleistungen', { exact: true })).toBeVisible();
    await expect(target.getByText('Bereit zur Fertigstellung', { exact: true })).toHaveCount(0);
  });
});
