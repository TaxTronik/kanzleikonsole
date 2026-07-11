import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    assertClientAccessTx: vi.fn(),
    evidenceRecord: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: m.assertClientAccessTx,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler.',
  }),
}));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: m.staffActionGuard,
  ActionError: m.ActionError,
}));

import { createFolderAction, renameFolderAction } from '../folder-actions';

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
  });
  m.evidenceRecord.mockResolvedValue({});
});

describe('Dokumentordner — RESTRICTED-Gate', () => {
  it('prüft den Mandantenzugriff vor dem Anlegen', async () => {
    const tx = {
      documentFolder: {
        create: vi.fn().mockResolvedValue({ id: 'folder-1' }),
      },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
      fn(tx),
    );

    const result = await createFolderAction({
      clientId: CLIENT_ID,
      parentId: null,
      name: 'Steuern 2026',
    });

    expect(result.ok).toBe(true);
    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.any(Object), CLIENT_ID);
    expect(m.assertClientAccessTx.mock.invocationCallOrder[0]).toBeLessThan(
      tx.documentFolder.create.mock.invocationCallOrder[0]!,
    );
  });

  it('führt bei verweigertem Zugriff keine Umbenennung aus', async () => {
    const tx = {
      documentFolder: {
        findFirst: vi.fn().mockResolvedValue({ name: 'Alt', clientId: CLIENT_ID }),
        update: vi.fn(),
      },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
      fn(tx),
    );
    m.assertClientAccessTx.mockRejectedValueOnce(new Error('Kein Zugriff auf diesen Mandanten.'));

    const result = await renameFolderAction({
      folderId: '22222222-2222-4222-8222-222222222222',
      name: 'Neu',
    });

    expect(result.ok).toBe(false);
    expect(tx.documentFolder.update).not.toHaveBeenCalled();
  });
});
