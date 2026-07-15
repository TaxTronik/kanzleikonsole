import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    tx: {
      $queryRaw: vi.fn(),
      document: {
        update: vi.fn(),
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

import { restoreDocumentAction, softDeleteDocumentAction } from '../actions';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.document.update.mockResolvedValue({});
  h.tx.document.updateMany.mockResolvedValue({ count: 1 });
  h.evidenceRecord.mockResolvedValue({});
});

describe('Dokument-Sichtbarkeit – GwG-Schutz', () => {
  it('sperrt ein vernichtetes GwG-Dokument vor jedem Restore-Update', async () => {
    h.tx.$queryRaw.mockResolvedValue([
      {
        id: DOCUMENT_ID,
        title: 'VERNICHTET',
        classification: 'GWG_EVIDENCE',
        clientId: 'client-1',
        deletedAt: new Date(),
        gwgDestroyedAt: new Date(),
      },
    ]);

    const result = await restoreDocumentAction({ documentId: DOCUMENT_ID });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('endgültig vernichteter GwG-Beleg');
    expect(h.tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('guarded auch den normalen Restore atomar auf gwgDestroyedAt null', async () => {
    h.tx.$queryRaw.mockResolvedValue([
      {
        id: DOCUMENT_ID,
        title: 'Beleg.pdf',
        classification: 'GENERAL',
        clientId: null,
        deletedAt: new Date(),
        gwgDestroyedAt: null,
      },
    ]);

    expect(await restoreDocumentAction({ documentId: DOCUMENT_ID })).toEqual({ ok: true });
    expect(h.tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID, deletedAt: { not: null }, gwgDestroyedAt: null },
      data: { deletedAt: null, deletedByStaff: null, deleteReason: null },
    });
  });

  it('lehnt das Ausblenden eines zugeordneten GwG-Nachweises verständlich ab', async () => {
    h.tx.$queryRaw
      .mockResolvedValueOnce([
        {
          id: DOCUMENT_ID,
          title: 'Ausweis.pdf',
          classification: 'GWG_EVIDENCE',
          clientId: null,
          deletedAt: null,
          gwgDestroyedAt: null,
        },
      ])
      .mockResolvedValueOnce([{ linked: true }]);

    const result = await softDeleteDocumentAction({ documentId: DOCUMENT_ID });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('bereits einer GwG-Prüfung zugeordnet'),
    });
    expect(h.tx.document.update).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });

  it('sperrt erst den Parent und liest danach die Zuordnung mit frischem Snapshot', async () => {
    h.tx.$queryRaw
      .mockResolvedValueOnce([
        {
          id: DOCUMENT_ID,
          title: 'Unverknüpft.pdf',
          classification: 'GENERAL',
          clientId: null,
          deletedAt: null,
          gwgDestroyedAt: null,
        },
      ])
      .mockResolvedValueOnce([{ linked: false }]);

    expect(await softDeleteDocumentAction({ documentId: DOCUMENT_ID })).toEqual({ ok: true });

    const statements = h.tx.$queryRaw.mock.calls.map(([strings]) =>
      Array.from(strings as TemplateStringsArray).join('?'),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('FOR UPDATE OF d');
    expect(statements[0]).not.toContain('gwg_id_document');
    expect(statements[1]).toContain('FROM gwg_id_document');
    expect(h.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      h.tx.document.update.mock.invocationCallOrder[0]!,
    );
  });

  it('erlaubt den Restore eines verknüpften Legacy-Zustands zur Selbstheilung', async () => {
    h.tx.$queryRaw.mockResolvedValue([
      {
        id: DOCUMENT_ID,
        title: 'Altbestand.pdf',
        classification: 'GWG_EVIDENCE',
        clientId: null,
        deletedAt: new Date(),
        gwgDestroyedAt: null,
      },
    ]);

    const result = await restoreDocumentAction({ documentId: DOCUMENT_ID });

    expect(result).toEqual({ ok: true });
    expect(h.tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID, deletedAt: { not: null }, gwgDestroyedAt: null },
      data: { deletedAt: null, deletedByStaff: null, deleteReason: null },
    });
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ action: 'document.restore', resourceId: DOCUMENT_ID }),
    );
  });
});
