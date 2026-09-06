// Fachkatalog: INV-PORTAL-SHARING-001
import { describe, expect, it } from 'vitest';
import { portalInvoiceVisibilityWhere } from '../portal-visibility';

describe('portalInvoiceVisibilityWhere', () => {
  it('zeigt nur ausgestellte Status und versendete Storni des Portal-Mandanten', () => {
    expect(portalInvoiceVisibilityWhere('client-1')).toEqual({
      clientId: 'client-1',
      OR: [
        { status: { in: ['SENT', 'PAID', 'OVERDUE'] } },
        { status: 'CANCELLED', sentAt: { not: null } },
      ],
    });
  });

  it('enthaelt weder DRAFT noch ein CANCELLED ohne Versandnachweis', () => {
    const where = JSON.stringify(portalInvoiceVisibilityWhere('client-1'));
    expect(where).not.toContain('DRAFT');
    expect(where).toContain('sentAt');
    expect(where).toContain('not');
  });
});
