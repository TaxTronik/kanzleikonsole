import { test, expect } from '@playwright/test';
import { mountBwa, plan, missingBase } from './helpers/bwa';

const completeBase = {
  ...missingBase,
  canApply: true,
  unavailableReason: null,
  revenue: 1000,
  costs: 800,
  resultBeforeTax: 245,
  result: 170,
  personnelCost: 400,
  material: 200,
  depreciation: 50,
  otherIncome: 45,
};
const emptyProjection = {
  year: 2026,
  revenue: null,
  otherIncome: null,
  personnelCost: null,
  material: null,
  depreciation: null,
  otherCosts: null,
  taxes: null,
  costs: null,
  resultBeforeTax: null,
  resultAfterTax: null,
  basis: 'Fehlende Achsen',
};
type CreatedPlan = { lines: Array<{ axis: string; amount: number }> };
async function createdPlan(page: import('@playwright/test').Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as typeof globalThis & { __calls: CreatedPlan[] }).__calls.length,
      ),
    )
    .toBe(1);
  return page.evaluate(
    () => (globalThis as typeof globalThis & { __calls: CreatedPlan[] }).__calls[0]!,
  );
}

test.describe('BWA-IMPORT-MAPPING-001 / BWA-PROJECTION-001: fehlende Werte bleiben unbekannt', () => {
  test('unvollständige Planbasis zeigt fehlende Erlöse und sperrt automatische Vorbelegung', async ({
    page,
  }) => {
    await mountBwa(page, 'wizard', { bases: [missingBase], defaultYear: 2027 });
    await page
      .getByLabel('Basis (aus welcher BWA übernehmen?)', { exact: true })
      .selectOption('base-a');
    await expect(page.locator('#bwa-plan-wizard-base-hint')).toContainText('Erlöse —');
    await expect(page.getByRole('button', { name: 'Basis', exact: true })).toBeDisabled();
    await expect(page.getByText(missingBase.unavailableReason, { exact: true })).toBeVisible();
    await expect(page.getByLabel('Prozentuale Anpassung')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Anwenden', exact: true })).toBeDisabled();
  });
  test('Szenario-Vergleich erfindet aus fehlenden Projektionsachsen keine Nullbeträge', async ({
    page,
  }) => {
    await mountBwa(page, 'comparison', { plans: [plan], projection: emptyProjection });
    await page.getByRole('checkbox', { name: 'Testplanung zum Vergleich auswählen' }).check();
    const table = page.getByRole('table');
    await expect(
      table
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: 'Erlöse', exact: true }) })
        .getByRole('cell')
        .last(),
    ).toHaveText('—');
    await expect(
      table
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: 'Ergebnis vor Steuern', exact: true }) })
        .getByRole('cell')
        .last(),
    ).toHaveText('—');
  });
  test('Planumsatz wird getrennt von sonstigen Erträgen mit der Hochrechnung verglichen', async ({
    page,
  }) => {
    await mountBwa(page, 'versus', {
      plans: [plan],
      projection: {
        revenue: 1000,
        costs: 800,
        personnelCost: 300,
        resultBeforeTax: 400,
        taxes: 120,
        resultAfterTax: 280,
      },
      projectionLabel: 'Synthetische BWA',
    });
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'Erlöse', exact: true }) });
    await expect(row.getByRole('cell').nth(1)).toContainText('1.000');
    await expect(row.getByRole('cell').nth(3)).toContainText('0');
    const result = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'Ergebnis vor Steuern', exact: true }) });
    await expect(result.getByRole('cell').nth(1)).toContainText('400');
  });

  test('gesperrte Basis verhindert keinen manuell erfassten und gespeicherten Plan', async ({
    page,
  }) => {
    await mountBwa(page, 'wizard', { bases: [missingBase], defaultYear: 2027 });
    await page
      .getByLabel('Basis (aus welcher BWA übernehmen?)', { exact: true })
      .selectOption('base-a');
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.locator('#bwa-wizard-axis-REVENUE-amount').fill('1234');
    await page.locator('#bwa-wizard-axis-OTHER_INCOME-amount').fill('56');
    await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    await page.getByRole('button', { name: 'Planung anlegen', exact: true }).click();
    const saved = await createdPlan(page);
    expect(saved.lines).toEqual(
      expect.arrayContaining([
        { axis: 'REVENUE', amount: 1234, note: null },
        { axis: 'OTHER_INCOME', amount: 56, note: null },
      ]),
    );
  });

  for (const source of ['DATEV', 'ADDISON', 'explizite Nullwerte'] as const) {
    test(`vollständige Basis ${source} wird mit getrennten Achsen tatsächlich gespeichert`, async ({
      page,
    }) => {
      const base =
        source === 'ADDISON'
          ? { ...completeBase, otherIncome: 50, resultBeforeTax: 250 }
          : source === 'explizite Nullwerte'
            ? {
                ...completeBase,
                revenue: 0,
                costs: 0,
                resultBeforeTax: 0,
                result: 0,
                personnelCost: 0,
                material: 0,
                depreciation: 0,
                otherIncome: 0,
              }
            : completeBase;
      await mountBwa(page, 'wizard', { bases: [base], defaultYear: 2027 });
      await page
        .getByLabel('Basis (aus welcher BWA übernehmen?)', { exact: true })
        .selectOption('base-a');
      await page.getByRole('button', { name: 'Basis', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Vorbelegung übernommen');
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await expect(page.locator('#bwa-wizard-axis-REVENUE-amount')).toHaveValue(
        String(base.revenue),
      );
      await expect(page.locator('#bwa-wizard-axis-MATERIAL-amount')).toHaveValue(
        String(base.material),
      );
      await expect(page.locator('#bwa-wizard-axis-DEPRECIATION-amount')).toHaveValue(
        String(base.depreciation),
      );
      await expect(page.locator('#bwa-wizard-axis-OTHER_INCOME-amount')).toHaveValue(
        String(base.otherIncome),
      );
      await page.getByRole('button', { name: 'Weiter', exact: true }).click();
      await page.getByRole('button', { name: 'Planung anlegen', exact: true }).click();
      const saved = await createdPlan(page);
      expect(Object.fromEntries(saved.lines.map((line) => [line.axis, line.amount]))).toEqual({
        REVENUE: base.revenue,
        OTHER_INCOME: base.otherIncome,
        PERSONNEL: base.personnelCost,
        MATERIAL: base.material,
        DEPRECIATION: base.depreciation,
        OTHER_COSTS: base.costs - base.personnelCost - base.material - base.depreciation,
        TAXES: Math.round(base.resultBeforeTax * 0.3),
      });
    });
  }

  test('Szenario-Vergleich zeigt eigenständige Ergebnisse und bekannte Nullwerte unverändert', async ({
    page,
  }) => {
    await mountBwa(page, 'comparison', {
      plans: [plan],
      projection: {
        ...emptyProjection,
        revenue: 2000,
        otherIncome: 90,
        costs: 1600,
        resultBeforeTax: 690,
        resultAfterTax: 483,
        taxes: 207,
        material: 0,
      },
    });
    await page.getByRole('checkbox', { name: 'Testplanung zum Vergleich auswählen' }).check();
    for (const [label, value] of [
      ['Material', '0'],
      ['Aufwendungen', '1.600'],
      ['Ergebnis vor Steuern', '690'],
      ['Ergebnis nach Steuern', '483'],
    ]) {
      await expect(
        page
          .getByRole('row')
          .filter({ has: page.getByRole('cell', { name: label!, exact: true }) })
          .getByRole('cell')
          .last(),
      ).toContainText(value!);
    }
  });

  test('echtes Dashboard reicht fehlende Ergebnisse bis in beide Vergleichsansichten durch', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-09-07T12:00:00Z'));
    await mountBwa(page, 'dashboard', {
      plans: [plan],
      linkPrefix: '/synthetic/plans',
      newPlanHref: null,
      periods: [
        {
          id: 'quarter-a',
          source: 'DATEV',
          periodKey: '2026-Q2',
          periodType: 'QUARTER',
          fromDate: '2026-01-01',
          toDate: '2026-06-30',
          positions: [
            { number: 1020, amount: 1000 },
            { number: 1060, amount: 200 },
            { number: 1280, amount: 600 },
            { number: 1100, amount: 400 },
          ],
        },
      ],
    });
    const versus = page
      .getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: 'Δ absolut', exact: true }) });
    await expect(
      versus
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: 'Ergebnis vor Steuern', exact: true }) })
        .getByRole('cell')
        .nth(2),
    ).toHaveText('—');
    await page.getByRole('checkbox', { name: 'Testplanung zum Vergleich auswählen' }).check();
    const comparison = page
      .getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: /Hochrechnung.*Lfd/ }) });
    for (const label of [
      'Sonstige Erträge',
      'Abschreibungen',
      'Sonstige Kosten',
      'Ergebnis vor Steuern',
      'Ergebnis nach Steuern',
    ]) {
      await expect(
        comparison
          .getByRole('row')
          .filter({ has: page.getByRole('cell', { name: label, exact: true }) })
          .getByRole('cell')
          .last(),
      ).toHaveText('—');
    }
    await expect(
      comparison
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: 'Material', exact: true }) })
        .getByRole('cell')
        .last(),
    ).toContainText('400');
  });
});

test.describe('BWA-TAX-ESTIMATE-001: tatsächliche Steuerkarten-Interaktion', () => {
  test('fehlende Vorsteuerbasis bietet keine Schätzung aus einem Nachsteuerergebnis an', async ({
    page,
  }) => {
    await mountBwa(page, 'tax', {
      result: 700,
      resultBeforeTax: null,
      revenue: 1000,
      inputVat: null,
      vatPaid: null,
      defaultLegalForm: 'GMBH',
      taxYear: 2026,
    });
    await expect(
      page.getByText('Für die Steuerschätzung fehlt ein belastbares Ergebnis vor Steuern.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(0);
  });
  test('bekannte Nullbasis öffnet die echte Schätzung mit Nullsteuer', async ({ page }) => {
    await mountBwa(page, 'tax', {
      resultBeforeTax: 0,
      revenue: null,
      inputVat: null,
      vatPaid: null,
      defaultLegalForm: 'GMBH',
      taxYear: 2026,
    });
    await page.getByRole('button', { name: /Steuerschätzung 2026/ }).click();
    await expect(
      page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: 'Gesamt', exact: true }) })
        .getByRole('cell')
        .last(),
    ).toContainText('0');
    await expect(page.getByLabel('Rechtsform')).toBeVisible();
  });
});
