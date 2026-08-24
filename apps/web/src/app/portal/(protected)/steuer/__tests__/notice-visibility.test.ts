// Fachkatalog: TAX-NOTICE-APPEAL-001

import { describe, expect, it } from 'vitest';
import { shouldShowAppealDeadlineToClient } from '../notice-visibility';

const calculated = {
  status: 'GEPRUEFT',
  deadlineCalculationStatus: 'CALCULATED',
  manualReviewRequired: false,
  appealDeadline: new Date('2026-07-01T00:00:00.000Z'),
};

describe('Fristanzeige im Mandantenportal', () => {
  it('zeigt nur vollständig berechnete Vorschläge ohne manuellen Prüfbedarf', () => {
    expect(shouldShowAppealDeadlineToClient(calculated)).toBe(true);
    expect(shouldShowAppealDeadlineToClient({ ...calculated, manualReviewRequired: true })).toBe(
      false,
    );
    expect(
      shouldShowAppealDeadlineToClient({
        ...calculated,
        deadlineCalculationStatus: 'MANUAL_REVIEW',
      }),
    ).toBe(false);
    expect(shouldShowAppealDeadlineToClient({ ...calculated, appealDeadline: null })).toBe(false);
  });

  it('beschränkt die Anzeige auf fachlich freigegebene Verfahrensstatus', () => {
    expect(shouldShowAppealDeadlineToClient({ ...calculated, status: 'NEU' })).toBe(false);
    expect(shouldShowAppealDeadlineToClient({ ...calculated, status: 'BESTANDSKRAEFTIG' })).toBe(
      false,
    );
  });
});
