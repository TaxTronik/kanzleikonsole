import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaxEstimatorCard } from '@/app/staff/(protected)/clients/[id]/bwa/[periodId]/tax-estimator-card';

const props = {
  result: 700,
  revenue: 1000,
  inputVat: null,
  vatPaid: null,
  defaultLegalForm: 'GMBH' as const,
  taxYear: 2026,
};
describe('BWA-TAX-ESTIMATE-001: tax card requires a known pre-tax basis', () => {
  it.each([2028, 2024, null])('hides all estimates for an unsupported period (%s)', (taxYear) => {
    const html = renderToStaticMarkup(
      <TaxEstimatorCard {...props} taxYear={taxYear} resultBeforeTax={100_000} />,
    );
    expect(html).toContain('nur für vollständige Kalenderjahre 2025 und 2026');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('€');
  });
  it.each([null, undefined, Number.NaN])(
    'shows an unavailable state without estimating from another result (%s)',
    (resultBeforeTax) => {
      const html = renderToStaticMarkup(
        <TaxEstimatorCard {...props} resultBeforeTax={resultBeforeTax} />,
      );
      expect(html).toContain('Für die Steuerschätzung fehlt ein belastbares Ergebnis vor Steuern.');
    },
  );
  it('accepts an explicitly reported zero pre-tax result', () => {
    const html = renderToStaticMarkup(<TaxEstimatorCard {...props} resultBeforeTax={0} />);
    expect(html).toContain('Steuerschätzung 2026 (Beta)');
    expect(html).not.toContain('fehlt ein belastbares');
  });
});
