// Fachkatalog: REQ-LIFECYCLE-001 — ein Portal-Formular ist nur offen, solange
// es PENDING/DRAFT ist und seine (gebundene) Anforderung offen ist.
import { describe, expect, it } from 'vitest';
import { isPortalFormOpen, isPortalFormRequestClosed } from '../form-open';

const bound = (status: string, requestStatus: string) => ({
  status,
  requestId: 'req-1',
  requests: [{ id: 'req-1', status: requestStatus }],
});

describe('isPortalFormOpen', () => {
  it('ist offen für PENDING/DRAFT mit offener oder bearbeiteter Anforderung', () => {
    expect(isPortalFormOpen(bound('PENDING', 'OPEN'))).toBe(true);
    expect(isPortalFormOpen(bound('DRAFT', 'IN_PROGRESS'))).toBe(true);
  });

  it('ist geschlossen, sobald die gebundene Anforderung nicht mehr offen ist', () => {
    for (const status of ['RESPONDED', 'CLOSED', 'CANCELLED']) {
      expect(isPortalFormOpen(bound('PENDING', status))).toBe(false);
      expect(isPortalFormRequestClosed(bound('PENDING', status))).toBe(true);
    }
  });

  it('gilt ohne auffindbare gebundene Anforderung als geschlossen (fail-closed)', () => {
    expect(isPortalFormOpen({ status: 'PENDING', requestId: 'req-1', requests: [] })).toBe(false);
    expect(
      isPortalFormOpen({
        status: 'PENDING',
        requestId: 'req-1',
        requests: [{ id: 'other', status: 'OPEN' }],
      }),
    ).toBe(false);
  });

  it('prüft Altbestände ohne requestId über alle verknüpften Anforderungen', () => {
    expect(isPortalFormOpen({ status: 'PENDING', requestId: null, requests: [] })).toBe(true);
    expect(
      isPortalFormOpen({
        status: 'PENDING',
        requestId: null,
        requests: [
          { id: 'a', status: 'OPEN' },
          { id: 'b', status: 'CLOSED' },
        ],
      }),
    ).toBe(false);
  });

  it('ist für übermittelte oder geprüfte Formulare nie offen', () => {
    expect(isPortalFormOpen(bound('SUBMITTED', 'OPEN'))).toBe(false);
    expect(isPortalFormOpen(bound('REVIEWED', 'OPEN'))).toBe(false);
  });
});
