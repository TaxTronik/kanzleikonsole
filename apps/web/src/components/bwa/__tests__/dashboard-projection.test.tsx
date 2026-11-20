// Fachkatalog: BWA-PROJECTION-001
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { parseAddisonBwaCsv } from '@/server/bwa/addison-parser';
import { BwaDashboard } from '../bwa-dashboard';

function renderDashboard(headers: string, amounts: string, now: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const parsed = parseAddisonBwaCsv(
    ['BWA', `Zeile;Name;${headers}`, `1990;Umsatz;${amounts}`].join('\n'),
  );
  expect(parsed.warnings).toEqual([]);
  const periods = parsed.periods.map((period) => ({
    ...period,
    id: period.periodKey,
    source: 'ADDISON' as const,
    periodType: period.type,
  }));
  return renderToStaticMarkup(
    <BwaDashboard periods={periods} plans={[]} linkPrefix="/portal/bwa/plan" newPlanHref={null} />,
  );
}

afterEach(() => vi.useRealTimers());

it('verwendet die jüngste unterjährige Periode vollständig innerhalb des Zieljahres', () => {
  const html = renderDashboard(
    '01.26-06.26;11.26-02.27',
    '60.000,00;400.000,00',
    '2026-11-20T10:00:00Z',
  );
  expect(html).toContain('Lfd. Jahr 2026-01-2026-06 (6/12 Monate)');
  expect(html).toContain('120.000');
  expect(html).not.toContain('1.200.000');
});

it('zeigt ohne passende Periode keine Jahreshochrechnung aus einem jahresübergreifenden Import', () => {
  const html = renderDashboard('11.26-02.27', '400.000,00', '2026-11-20T10:00:00Z');
  expect(html).not.toContain('Jahres-Hochrechnung');
});

it.each([
  ['2026-12-31T22:59:59.999Z', 2026],
  ['2026-12-31T23:00:00.000Z', 2027],
] as const)('zeigt am Berliner Jahreswechsel für %s das Zieljahr %i', (now, year) => {
  const html = renderDashboard('12.26-12.26;01.27-01.27', '10.000,00;20.000,00', now);
  expect(html).toContain(`Jahres-Hochrechnung ${year}`);
  expect(html).toContain(`Lfd. Jahr ${year}-`);
});
