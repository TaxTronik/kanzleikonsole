// Fachkatalog: INV-NUMBER-ALLOCATION-001, STBVV-CALCULATION-001
//
// Produktentscheidung A4 (2026-10-07): Die StBVV-Übernahme behält ihre
// Fälligkeitsprüfung; Meldung und Prüfung kommen jetzt aus dem gemeinsamen
// Anlageservice, damit alle Rechnungspfade wortgleich ablehnen.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createFeeInvoice: vi.fn(),
  readModulesTx: vi.fn(),
}));

vi.mock('@/server/actions/staff-action', async () => {
  const { ActionError } = await import('@/server/actions/action-error');
  return {
    ActionError,
    requireUuidParam: (value: unknown) => value as string,
    // Wie withStaff: Callback im Tenant-Kontext, ActionError als Ergebnis.
    withStaff: async (fn: (tx: unknown, g: unknown) => Promise<Record<string, unknown>>) => {
      try {
        return { ok: true, ...(await fn({}, { tenantId: 'tenant-1', staffId: 'staff-1' })) };
      } catch (error) {
        if (error instanceof ActionError) return { ok: false, error: error.message };
        throw error;
      }
    },
  };
});
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({ readModulesTx: m.readModulesTx }));
vi.mock('@/server/stbvv/service', () => ({
  createFeeInvoice: m.createFeeInvoice,
  validateFeeCalculation: vi.fn(),
  feeJson: vi.fn(),
}));
vi.mock('@/server/actions/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/settings/tenant-settings', () => ({ readSellerInfoTx: vi.fn() }));
vi.mock('@taxtronik/db', () => ({}));

import { INVOICE_DATES_INVALID } from '@/server/invoicing/create-draft';
import { createStbvvDraftAction } from '../actions';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const QUOTE = '22222222-2222-4222-8222-222222222222';

describe('createStbvvDraftAction – Fälligkeit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.readModulesTx.mockResolvedValue({ invoiceMode: 'IN_APP' });
    m.createFeeInvoice.mockResolvedValue({ invoiceId: 'invoice-1', existing: false });
  });

  it.each([
    ['vor dem Rechnungsdatum', '2026-10-05', '2026-10-04'],
    ['ohne gültiges Datum', '2026-10-05', '05.10.2026'],
  ])('lehnt eine Fälligkeit %s mit der gemeinsamen Meldung ab', async (_name, issue, due) => {
    await expect(createStbvvDraftAction(CLIENT, QUOTE, issue, due)).resolves.toEqual({
      ok: false,
      error: INVOICE_DATES_INVALID,
    });
    expect(m.createFeeInvoice).not.toHaveBeenCalled();
  });

  it('übernimmt eine Fälligkeit am Rechnungsdatum', async () => {
    await expect(
      createStbvvDraftAction(CLIENT, QUOTE, '2026-10-05', '2026-10-05'),
    ).resolves.toMatchObject({ ok: true, invoiceId: 'invoice-1' });
    expect(m.createFeeInvoice).toHaveBeenCalledWith(
      {},
      'tenant-1',
      'staff-1',
      CLIENT,
      QUOTE,
      '2026-10-05',
      '2026-10-05',
    );
  });
});
