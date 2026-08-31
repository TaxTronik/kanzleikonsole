// Fachkatalog: GWG-OCR-ASSIST-001, GWG-IDENTIFICATION-EVIDENCE-001
import { test, expect } from '@playwright/test';

const fixture = process.env['E2E_IDENTITY_FIXTURE_URL'];
test.describe('lokale Ausweiserfassung mit synthetischen Dateien', () => {
  test.skip(!fixture, 'Separaten identity-smoke-server starten; keine Kanzleidaten verwenden.');
  test.setTimeout(120_000);

  for (const format of ['pdf', 'png', 'jpg']) {
    test(`${format}: lokale Erkennung, selektive Übernahme, keine externen Anfragen`, async ({
      page,
      context,
    }) => {
      const requests: string[] = [];
      context.on('request', (request) => requests.push(request.url()));
      await page.goto(fixture!);
      await page.getByRole('combobox', { name: 'Testformat' }).selectOption(format);
      await page.getByRole('button', { name: 'Ausweis zuschneiden und Daten erkennen' }).click();
      await page.getByRole('button', { name: 'Daten erkennen', exact: true }).click();
      const birth = page.getByRole('checkbox', { name: 'Geburtsdatum: 1964-08-12' });
      await expect(birth).toBeVisible({ timeout: 90_000 });
      await expect(page.locator('output')).toHaveText('{"fullName":"Vorhandener Name"}');
      await expect(
        page.getByRole('button', { name: 'Ausgewählte Daten übernehmen (ungeprüft)' }),
      ).toBeDisabled();
      await birth.check();
      await page.getByRole('button', { name: 'Ausgewählte Daten übernehmen (ungeprüft)' }).click();
      await expect(page.locator('output')).toHaveText(
        '{"fullName":"Vorhandener Name","birthDate":"1964-08-12"}',
      );
      const remote = requests.filter(
        (url) => /^https?:/.test(url) && new URL(url).origin !== new URL(fixture!).origin,
      );
      expect(remote).toEqual([]);
      expect(requests.some((url) => url.includes('/identity-assets/ocr-worker.js'))).toBe(true);
    });
  }

  test('zwei PDF-Seiten binden dieselbe Quelle mit eigener Drehung und Ausschnitt', async ({
    page,
  }) => {
    await page.goto(fixture!);
    await page.getByRole('button', { name: 'Ausweis zuschneiden und Daten erkennen' }).click();
    await page.getByRole('button', { name: 'Ausschnitt als Vorderseite übernehmen' }).click();
    await page.getByRole('combobox', { name: 'Ausweisseite', exact: true }).selectOption('back');
    await page.getByRole('combobox', { name: 'PDF-Seite' }).selectOption('2');
    await page.getByRole('button', { name: '90° drehen' }).click();
    await page.getByRole('spinbutton', { name: 'Breite %' }).fill('80');
    await page.getByRole('button', { name: 'Ausschnitt als Rückseite übernehmen' }).click();
    const views = JSON.parse(await page.locator('pre').innerText());
    expect(views).toHaveLength(2);
    expect(views[0].documentId).toBe(views[1].documentId);
    expect(views[0].versionId).toBe(views[1].versionId);
    expect(views[1]).toMatchObject({ side: 'back', page: 2, rotation: 90, width: 0.8 });
    await expect(page.locator('output')).toHaveText('{"fullName":"Vorhandener Name"}');
  });

  test('Abbruch während Initialisierung gibt die manuelle Weiterarbeit frei', async ({ page }) => {
    await page.goto(fixture!);
    await page.getByRole('combobox', { name: 'Testformat' }).selectOption('png');
    await page.getByRole('button', { name: 'Ausweis zuschneiden und Daten erkennen' }).click();
    await page.getByRole('button', { name: 'Daten erkennen', exact: true }).click();
    await page.getByRole('button', { name: 'Erkennung abbrechen' }).click();
    await expect(page.getByRole('alert')).toContainText('Manuelle Erfassung bleibt möglich.');
    await expect(page.getByRole('button', { name: 'Ausweishilfe schließen' })).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Ausschnitt als Vorderseite übernehmen' }),
    ).toBeEnabled();
    await expect(page.locator('output')).toHaveText('{"fullName":"Vorhandener Name"}');
  });

  test('unlesbare PDF lässt vorhandene Eingaben unverändert und blockiert keinen neuen Versuch', async ({
    page,
  }) => {
    await page.goto(fixture!);
    await page.getByRole('combobox', { name: 'Testformat' }).selectOption('broken');
    await page.getByRole('button', { name: 'Ausweis zuschneiden und Daten erkennen' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ausweishilfe schließen' })).toBeEnabled();
    await expect(page.locator('output')).toHaveText('{"fullName":"Vorhandener Name"}');
    await page.getByRole('combobox', { name: 'Testformat' }).selectOption('png');
    await page.getByRole('button', { name: 'Ausweis zuschneiden und Daten erkennen' }).click();
    await expect(page.getByRole('button', { name: 'Daten erkennen', exact: true })).toBeEnabled();
  });
});
