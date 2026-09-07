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
