// Fachkatalog: DOC-VERSION-IMMUTABILITY-001, GWG-RETENTION-DESTRUCTION-001
// Sichtbarkeit (Soft-Delete/Restore) von Dokumenten mit GwG-Bezug. Soft-Delete
// läuft seit P-18 nur noch über die Bulk-Action softDeleteDocumentsAction (die
// Einzel-Action hatte keinen Aufrufer mehr); geprüft wird dieselbe
// Dokumentfunktion je Eintrag.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  return {
    tx: {
      $queryRaw: vi.fn(),
      document: {
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      riskResearchResult: { updateMany: vi.fn() },
    },
    evidenceRecord: vi.fn(),
    assertClientAccessTx: vi.fn(),
    revalidatePath: vi.fn(),
    staff: {
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      session: {},
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
// Bulk-Kern (runDocumentBulk): jede Blocktransaktion auf derselben Attrappe.
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: typeof h.tx) => unknown) => fn(h.tx),
}));
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
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: h.assertClientAccessTx,
}));
vi.mock('@/server/actions/staff-action', async () => ({
  ActionError: (await import('@/server/actions/action-error')).ActionError,
  staffActionGuard: async () => ({ ok: true, ...h.staff }),
  withStaff: async (fn: (tx: typeof h.tx, ctx: unknown) => Promise<unknown>) => {
    try {
      await fn(h.tx, h.staff);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Fehler' };
    }
  },
}));

import { restoreDocumentAction, softDeleteDocumentsAction } from '../actions';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

/** Antworten der Rohabfragen: Blocksperren leer, danach Zeilensperre und GwG-Zuordnung. */
function answerQueries(row: Record<string, unknown>, linked: boolean) {
  h.tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    if (sql.includes('FOR UPDATE OF d')) return [row];
    if (sql.includes('FROM gwg_id_document')) return [{ linked }];
    return [];
  });
}

function statements(): string[] {
  return h.tx.$queryRaw.mock.calls.map(([strings]) =>
    Array.from(strings as TemplateStringsArray).join('?'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.document.update.mockResolvedValue({});
  h.tx.document.updateMany.mockResolvedValue({ count: 1 });
  h.tx.riskResearchResult.updateMany.mockResolvedValue({ count: 0 });
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
    answerQueries(
      {
        id: DOCUMENT_ID,
        title: 'Ausweis.pdf',
        classification: 'GWG_EVIDENCE',
        clientId: null,
        deletedAt: null,
        gwgDestroyedAt: null,
      },
      true,
    );

    const result = await softDeleteDocumentsAction({ documentIds: [DOCUMENT_ID] });

    expect(result).toEqual({
      ok: false,
      done: 0,
      rejected: [
        {
          id: DOCUMENT_ID,
          error: expect.stringContaining('bereits einer GwG-Prüfung zugeordnet'),
        },
      ],
    });
    expect(h.tx.document.update).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('sperrt erst den Parent und liest danach die Zuordnung mit frischem Snapshot', async () => {
    answerQueries(
      {
        id: DOCUMENT_ID,
        title: 'Unverknüpft.pdf',
        classification: 'GENERAL',
        clientId: null,
        deletedAt: null,
        gwgDestroyedAt: null,
      },
      false,
    );

    expect(await softDeleteDocumentsAction({ documentIds: [DOCUMENT_ID] })).toEqual({
      ok: true,
      done: 1,
      rejected: [],
    });

    // Nach den Blocksperren: erst die Zeilensperre, dann die Zuordnung als
    // eigenes Statement (READ COMMITTED sieht so einen parallelen Commit).
    const all = statements();
    const lock = all.findIndex((sql) => sql.includes('FOR UPDATE OF d'));
    const link = all.findIndex((sql) => sql.includes('FROM gwg_id_document'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(link).toBe(lock + 1);
    expect(all[lock]).not.toContain('gwg_id_document');
    expect(h.tx.$queryRaw.mock.invocationCallOrder[link]).toBeLessThan(
      h.tx.document.update.mock.invocationCallOrder[0]!,
    );
    expect(h.tx.riskResearchResult.updateMany).toHaveBeenCalledWith({
      where: { shelfDocumentId: DOCUMENT_ID },
      data: { shelfDocumentId: null },
    });
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
      expect.objectContaining({
        action: 'document.restore',
        resourceId: DOCUMENT_ID,
        // R-12: Mandant und Akteur aus dem Gate-Kontext (audit(tx, g, …)).
        tenantId: 'tenant-1',
        actorType: 'STAFF',
        actorId: 'staff-1',
      }),
    );
  });
});
