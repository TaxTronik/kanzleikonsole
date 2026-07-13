import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    tx: {
      document: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
    },
    evidenceRecord: vi.fn(),
    assertClientAccessTx: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/storage', () => ({
  fetchObjectBytes: vi.fn(),
  commitBytesWithTier: vi.fn(),
  deleteObject: vi.fn(),
  deleteObjectVersion: vi.fn(),
  classificationToTier: vi.fn(),
  gobdRetentionYears: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: vi.fn() }));
vi.mock('@/server/storage/document-type', () => ({ carrierClassification: vi.fn() }));
vi.mock('@/server/storage/retag-policy', () => ({ documentRetagDecision: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: h.assertClientAccessTx,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler',
  }),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: h.ActionError,
  staffActionGuard: vi.fn(),
  withStaff: async (fn: (tx: typeof h.tx, ctx: unknown) => Promise<unknown>) => {
    try {
      await fn(h.tx, {
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        session: {},
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Fehler' };
    }
  },
}));

import { restoreDocumentAction } from '../actions';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.document.updateMany.mockResolvedValue({ count: 1 });
  h.evidenceRecord.mockResolvedValue({});
});

describe('restoreDocumentAction – endgültige GwG-Vernichtung', () => {
  it('sperrt ein vernichtetes GwG-Dokument vor jedem Restore-Update', async () => {
    h.tx.document.findFirst.mockResolvedValue({
      id: DOCUMENT_ID,
      title: 'VERNICHTET',
      clientId: 'client-1',
      gwgDestroyedAt: new Date(),
    });

    const result = await restoreDocumentAction({ documentId: DOCUMENT_ID });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('endgültig vernichteter GwG-Beleg');
    expect(h.tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('guarded auch den normalen Restore atomar auf gwgDestroyedAt null', async () => {
    h.tx.document.findFirst.mockResolvedValue({
      id: DOCUMENT_ID,
      title: 'Beleg.pdf',
      clientId: null,
      gwgDestroyedAt: null,
    });

    expect(await restoreDocumentAction({ documentId: DOCUMENT_ID })).toEqual({ ok: true });
    expect(h.tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID, deletedAt: { not: null }, gwgDestroyedAt: null },
      data: { deletedAt: null, deletedByStaff: null, deleteReason: null },
    });
  });
});
