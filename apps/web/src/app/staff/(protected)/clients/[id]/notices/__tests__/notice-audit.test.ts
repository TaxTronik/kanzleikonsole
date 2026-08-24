// Fachkatalog: TAX-NOTICE-APPEAL-001

import { describe, expect, it } from 'vitest';
import {
  taxNoticeCreateAudit,
  taxNoticeStatusAfterAudit,
  taxNoticeStatusBeforeAudit,
} from '../notice-audit';

describe('TaxNotice Audit-Datenminimierung', () => {
  it('übernimmt bei der Anlage nur die Positivliste und einen Fingerprint', () => {
    const audit = taxNoticeCreateAudit({
      id: 'notice-1',
      clientId: 'client-1',
      filingId: null,
      deadlineCalculationStatus: 'CALCULATED',
      deadlineCalculationVersion: 'v1',
      manualReviewRequired: false,
      retrievalReinstatementReviewRequired: false,
      recipientName: 'Erika Musterfrau',
      authorityName: 'Finanzamt Beispielstadt',
      holidayContextNote: 'personenbezogener Sachverhalt',
    });

    const json = JSON.stringify(audit);
    expect(json).not.toContain('Erika Musterfrau');
    expect(json).not.toContain('Finanzamt Beispielstadt');
    expect(json).not.toContain('personenbezogener Sachverhalt');
    expect(audit.recordSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ersetzt Statusdaten durch Nachweismerkmale und ignoriert unbekannte Klartextfelder', () => {
    const before = taxNoticeStatusBeforeAudit({
      status: 'EINSPRUCH',
      appealFiledAt: new Date('2026-02-01T00:00:00.000Z'),
      appealFiledBy: 'staff-1',
      appealResolvedAt: null,
      appealDecisionReceivedAt: null,
      klageFiledAt: null,
      klageFiledBy: null,
    });
    const after = taxNoticeStatusAfterAudit(
      'notice-1',
      {
        status: 'BESTANDSKRAEFTIG',
        eventDateRecorded: true,
        legalFinalReasonRecorded: true,
        legalFinalReason: 'Mandant schilderte vertrauliche Einzelheiten.',
      },
      { legalFinalReason: 'Mandant schilderte vertrauliche Einzelheiten.' },
    );

    expect(before).toMatchObject({ appealFilingRecorded: true });
    expect(JSON.stringify(before)).not.toContain('2026-02-01');
    expect(JSON.stringify(after)).not.toContain('Mandant schilderte');
    expect(after.recordSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
