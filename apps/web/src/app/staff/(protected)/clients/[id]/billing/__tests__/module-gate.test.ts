import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  readModules: vi.fn(),
  withTenantContext: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/settings/modules', () => ({ readModules: m.readModules }));
vi.mock('@/server/actions/staff-action', async () => ({
  ActionError: (await import('@/server/actions/action-error')).ActionError,
  staffActionGuard: m.staffActionGuard,
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(m.staffActionGuard),
}));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: vi.fn(),
}));
vi.mock('@/server/invoicing/number', () => ({ allocateInvoiceNumber: vi.fn() }));
vi.mock('@/server/invoicing/time-billing', () => ({
  buildTimeBillingPositions: vi.fn(),
  claimTimeEntriesForInvoice: vi.fn(),
  validateTimeBillingTax: vi.fn(),
}));

import { createInvoiceFromTimeEntriesAction } from '../actions';

describe('Stundenabrechnung-Modulgate', () => {
  it('prüft Zeiterfassung und Rechnungsmodus vor Validierung oder Mutation', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: false,
      error: 'Modul timeTracking ist deaktiviert.',
    });

    await expect(createInvoiceFromTimeEntriesAction({} as never)).resolves.toEqual({
      ok: false,
      error: 'Modul timeTracking ist deaktiviert.',
    });

    expect(m.staffActionGuard).toHaveBeenCalledWith({
      requirePermission: 'INVOICE_MANAGE',
      module: 'timeTracking',
      modeModule: 'invoices',
    });
    expect(m.readModules).not.toHaveBeenCalled();
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });
});
