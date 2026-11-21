// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { savedPlanTotals } from '@/lib/bwa-plan';
import { fmtEURRound } from '@/lib/fmt';
import { PlanEditor } from '../plan-editor';
import { PlanWizard } from '../plan-wizard';
import { PlanListWithCompare, type PlanForCompare } from '../plan-comparison';
import { PlanVsProjection } from '../plan-vs-projection';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);

const amounts = [
  { axis: 'REVENUE', amount: 100 },
  { axis: 'OTHER_INCOME', amount: 25 },
  { axis: 'PERSONNEL', amount: 40 },
  { axis: 'MATERIAL', amount: 3 },
  { axis: 'DEPRECIATION', amount: 2 },
  { axis: 'OTHER_COSTS', amount: 1 },
  { axis: 'TAXES', amount: 24 },
] as const;
const plan: PlanForCompare = {
  id: 'vergleich',
  name: 'Plan 2026',
  year: 2026,
  status: 'FINAL',
  updatedAt: new Date('2026-01-01'),
  lines: [...amounts],
};

function expectSummary() {
  for (const [label, expected] of [
    ['Erträge', 125],
    ['Aufwendungen', 46],
    ['Ergebnis vor Steuern', 79],
    ['Ergebnis nach Steuern', 55],
  ] as const) {
    expect(
      screen
        .getAllByText(label)
        .some((el) => el.nextElementSibling?.textContent === fmtEURRound(expected)),
    ).toBe(true);
  }
}

function expectPlanCell(label: string, value: number) {
  const name = screen.getByText(label);
  expect(name.closest('tr')?.cells[1]?.textContent).toBe(fmtEURRound(value));
}

describe('BWA-PROJECTION-001 und BWA-IMPORT-MAPPING-001 – Planbeträge', () => {
  it('übernimmt die gerundeten Achsen und schätzt Steuern auf das Vorsteuerergebnis', () => {
    render(
      <PlanWizard
        defaultYear={2026}
        onCreate={vi.fn()}
        bases={[
          {
            id: 'basis',
            label: 'Basisjahr',
            periodKey: '2025',
            periodType: 'YEAR',
            canApply: true,
            unavailableReason: null,
            revenue: 100.1,
            otherIncome: 25.1,
            personnelCost: 40.1,
            material: 3.1,
            depreciation: 2.1,
            costs: 46.4,
            resultBeforeTax: 78.8,
            result: 55,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'basis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Basis' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expectSummary();
  });
  it('zeigt im Editor Erträge einschließlich sonstiger Erträge vor der ersten Änderung', () => {
    render(
      <PlanEditor
        planId={plan.id}
        backHref="/"
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        initial={{
          name: plan.name,
          notes: '',
          status: 'FINAL',
          lines: amounts.map((line) => ({ ...line, note: '' })),
        }}
      />,
    );
    expectSummary();
  });
  it('zeigt Einzelachsen und Gesamterträge nach Auswahl der Vergleichsspalte', () => {
    render(
      <PlanListWithCompare
        plans={[plan, { ...plan, id: 'vorjahr', year: 2027, name: 'Plan 2027' }]}
        projection={null}
      />,
    );
    for (const box of screen.getAllByRole('checkbox', { name: /zum Vergleich auswählen/ }))
      fireEvent.click(box);
    expectPlanCell('Erlöse', 100);
    expectPlanCell('Sonstige Erträge', 25);
    expectPlanCell('Erträge', 125);
    expectPlanCell('Ergebnis nach Steuern', 55);
  });
  it('vergleicht Umsatzerlöse mit der Umsatzachse der Hochrechnung', () => {
    const view = render(
      <PlanVsProjection
        plans={[plan]}
        projection={{
          revenue: null,
          costs: null,
          resultBeforeTax: null,
          resultAfterTax: null,
          taxes: null,
          personnelCost: null,
        }}
        projectionLabel="Testjahr"
      />,
    );
    expectPlanCell('Erlöse', 100);
    expectPlanCell('Ergebnis vor Steuern', 79);
    expect(
      within(view.getByRole('row', { name: /^Erlöse/ })).getAllByRole('cell')[1]?.textContent,
    ).toBe('—');
  });
  it.each([1, -1])(
    'zeigt die Summe von vier Centbeträgen an der Halbeurogrenze (Vorzeichen %i)',
    (sign) => {
      const klein: PlanForCompare = {
        ...plan,
        lines: [
          { axis: 'PERSONNEL', amount: sign * 0.01 },
          { axis: 'MATERIAL', amount: sign * 0.18 },
          { axis: 'DEPRECIATION', amount: sign * 0.29 },
          { axis: 'OTHER_COSTS', amount: sign * 0.02 },
        ],
      };
      render(
        <PlanListWithCompare
          plans={[klein, { ...plan, id: 'vorjahr', year: 2027, name: 'Plan 2027' }]}
          projection={null}
        />,
      );
      for (const box of screen.getAllByRole('checkbox', { name: /zum Vergleich auswählen/ }))
        fireEvent.click(box);
      expectPlanCell('Aufwendungen', sign * 0.5);
      expectPlanCell('Ergebnis nach Steuern', -sign * 0.5);
    },
  );
  it('rechnet auf derselben Cent-Skala wie gespeicherte Planzeilen, auch bei negativen Halbcentbeträgen', () => {
    const totals = savedPlanTotals({
      lines: [
        { axis: 'REVENUE', amount: 1.005 },
        { axis: 'OTHER_INCOME', amount: -1.005 },
        { axis: 'MATERIAL', amount: -0.02 },
        { axis: 'DEPRECIATION', amount: 0.02 },
      ],
    });
    expect(totals).toMatchObject({ revenue: 1.01, totalIncome: 0, costs: 0, resultAfterTax: 0 });
  });
  it('erhält bei lückenhaften Altplänen Null, Vorzeichen und den ersten Betrag einer Achse', () => {
    for (const revenue of [-100, 0, 100]) {
      for (const otherIncome of [-25, 0, 25]) {
        for (const costs of [0, 20, 45]) {
          const values = savedPlanTotals({
            lines: [
              { axis: 'REVENUE', amount: revenue },
              { axis: 'REVENUE', amount: 999 },
              { axis: 'OTHER_INCOME', amount: otherIncome },
              { axis: 'MATERIAL', amount: costs },
            ],
          });
          expect(values).toEqual({
            revenue,
            totalIncome: revenue + otherIncome,
            personnelCost: 0,
            costs,
            taxes: 0,
            resultBeforeTax: revenue + otherIncome - costs,
            resultAfterTax: revenue + otherIncome - costs,
          });
        }
      }
    }
  });
});
