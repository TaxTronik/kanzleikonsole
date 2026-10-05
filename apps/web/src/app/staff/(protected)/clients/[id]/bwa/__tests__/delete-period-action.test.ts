// Review-Befund F-01: Das Löschen einer BWA-Periode meldet Gate-, Eingabe- und
// Fachfehler als `{ ok: false, error }` an das Formular (vorher stilles Abbrechen).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/bwa/addison-parser', () => ({
  parseAddisonBwaCsv: vi.fn(),
  parseAddisonBwaCompactCsv: vi.fn(),
}));
vi.mock('@/server/bwa/datev-parser', () => ({ parseDatevBwaXlsx: vi.fn() }));
vi.mock('@/server/auth/rbac', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  return {
    assertClientAccessTx: h.assertClientAccessTx,
    toActionError: (error: unknown) => ({
      ok: false,
      error: error instanceof ActionError ? error.message : 'Unerwarteter Fehler.',
    }),
  };
});
vi.mock('@/server/actions/staff-action', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  const { parseFormData } = await vi.importActual<typeof import('@/server/actions/form-data')>(
    '@/server/actions/form-data',
  );
  return { ActionError, parseFormData, staffActionGuard: h.staffActionGuard };
});

import { deleteBwaPeriodAction } from '../actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const PERIOD_ID = '22222222-2222-4222-8222-222222222222';

function deleteForm(periodId = PERIOD_ID): FormData {
  const formData = new FormData();
  formData.set('periodId', periodId);
  formData.set('clientId', CLIENT_ID);
  return formData;
}

describe('deleteBwaPeriodAction — Rückkanal', () => {
  const tx = { bwaPeriod: { findFirst: vi.fn(), delete: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
    });
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));
    h.assertClientAccessTx.mockResolvedValue(undefined);
  });

  it('meldet ein abgeschaltetes Modul, statt still nichts zu tun', async () => {
    h.staffActionGuard.mockResolvedValue({ ok: false, error: 'Modul deaktiviert.' });

    await expect(deleteBwaPeriodAction(null, deleteForm())).resolves.toEqual({
      ok: false,
      error: 'Modul deaktiviert.',
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('meldet eine ungültige Perioden-ID, ohne die Transaktion zu öffnen', async () => {
    await expect(deleteBwaPeriodAction(null, deleteForm('keine-uuid'))).resolves.toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('meldet eine unbekannte Periode und löscht nichts', async () => {
    tx.bwaPeriod.findFirst.mockResolvedValue(null);

    await expect(deleteBwaPeriodAction(null, deleteForm())).resolves.toEqual({
      ok: false,
      error: 'BWA-Zeitraum nicht gefunden.',
    });
    expect(tx.bwaPeriod.delete).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
