import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: mocks.staffActionGuard }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));

import {
  dismissSetupChecklistAction,
  restoreSetupChecklistAction,
} from '@/app/staff/(protected)/admin/setup-actions';
import { SETUP_DISMISSED_SETTING_KEY } from '../constants';

function makeTx() {
  return {
    tenantSetting: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  mocks.evidenceRecord.mockResolvedValue({});
});

describe('Setup-Einführung', () => {
  it('persistiert und auditiert das Überspringen admin-geschützt', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await dismissSetupChecklistAction();

    expect(mocks.staffActionGuard).toHaveBeenCalledWith({ requireAdmin: true });
    expect(tx.tenantSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_key: { tenantId: 'tenant-1', key: SETUP_DISMISSED_SETTING_KEY },
        },
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          key: SETUP_DISMISSED_SETTING_KEY,
          value: expect.objectContaining({ dismissed: true }),
          updatedBy: 'staff-1',
        }),
      }),
    );
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'tenant.setup.dismiss', after: { dismissed: true } }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/staff/dashboard');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/staff/admin');
  });

  it('entfernt den Marker beim bewussten Wiedereinblenden', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await restoreSetupChecklistAction();

    expect(tx.tenantSetting.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', key: SETUP_DISMISSED_SETTING_KEY },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'tenant.setup.restore', after: { dismissed: false } }),
    );
  });

  it('schreibt ohne Admin-Berechtigung nichts', async () => {
    mocks.staffActionGuard.mockResolvedValue({ ok: false, error: 'Keine Berechtigung.' });
    await dismissSetupChecklistAction();
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
