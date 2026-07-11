import { beforeEach, describe, expect, it, vi } from 'vitest';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    withStaff: vi.fn(),
    assertClientAccessTx: vi.fn(),
    evidenceRecord: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: m.assertClientAccessTx }));
vi.mock('@/server/actions/staff-action', () => ({
  withStaff: m.withStaff,
  ActionError: m.ActionError,
}));

import { acknowledgeDocumentAction } from '../acknowledge-actions';

beforeEach(() => {
  vi.clearAllMocks();
  m.evidenceRecord.mockResolvedValue({});
});

describe('Empfangsbestätigung — RESTRICTED-Gate', () => {
  it('prüft den Mandantenzugriff vor der Dokumentänderung', async () => {
    const tx = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          title: 'Beleg',
          clientId: CLIENT_ID,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    m.withStaff.mockImplementation(async (fn: (arg: unknown, ctx: unknown) => unknown) => {
      await fn(tx, {
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
      });
      return { ok: true };
    });

    const result = await acknowledgeDocumentAction({
      documentId: DOCUMENT_ID,
      acknowledged: true,
    });

    expect(result).toEqual({ ok: true });
    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.any(Object), CLIENT_ID);
    expect(m.assertClientAccessTx.mock.invocationCallOrder[0]).toBeLessThan(
      tx.document.update.mock.invocationCallOrder[0]!,
    );
  });

  it('ändert bei verweigertem Zugriff nichts', async () => {
    const tx = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          title: 'Beleg',
          clientId: CLIENT_ID,
        }),
        update: vi.fn(),
      },
    };
    m.assertClientAccessTx.mockRejectedValueOnce(new Error('Kein Zugriff.'));
    m.withStaff.mockImplementation(async (fn: (arg: unknown, ctx: unknown) => unknown) => {
      try {
        await fn(tx, {
          tenantId: 'tenant-1',
          staffId: 'staff-1',
          session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    });

    const result = await acknowledgeDocumentAction({
      documentId: DOCUMENT_ID,
      acknowledged: true,
    });
    expect(result.ok).toBe(false);
    expect(tx.document.update).not.toHaveBeenCalled();
  });
});
