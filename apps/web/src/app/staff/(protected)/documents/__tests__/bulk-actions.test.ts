// Fachkatalog: DOC-PORTAL-SHARING-001
// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Review-Finding P-18: Verschieben, Freigeben, Löschen und Umtypisieren einer
// Auswahl laufen als EINE Server Action mit ID-Liste — eine Transaktion,
// Zugriffsprüfung und Audit-Event je Dokument wie bisher, eine Revalidierung.
import { Prisma } from '@taxtronik/db/prisma-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  class ForbiddenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ForbiddenError';
    }
  }
  return {
    ActionError,
    ForbiddenError,
    staffActionGuard: vi.fn(),
    assertClientAccessTx: vi.fn(),
    revalidatePath: vi.fn(),
    fetchObjectBytes: vi.fn(),
    deleteObject: vi.fn(),
    deleteObjectVersion: vi.fn(),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    db: null as unknown as FakeDb,
  };
});

// ---------------------------------------------------------------------------
// Transaktionale In-Memory-Datenbank: Writes einer gescheiterten Transaktion
// (inklusive Audit-Events) werden verworfen wie bei PostgreSQL.
// ---------------------------------------------------------------------------
interface DocRow {
  id: string;
  title: string;
  classification: string;
  clientId: string | null;
  folderId: string | null;
  documentTypeId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  deletedByStaff: string | null;
  deleteReason: string | null;
  gwgDestroyedAt: Date | null;
  sharedWithClientAt: Date | null;
  sharedByStaff: string | null;
  retentionUntil: Date | null;
  gwgLinked: boolean;
  payroll: boolean;
}
interface VersionRow {
  id: string;
  documentId: string;
  versionNo: number;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
  immutable: boolean;
  scanStatus: string;
}
interface TypeRow {
  id: string;
  tier: 'NONE' | 'GWG' | 'GOBD';
  classificationKey: string | null;
  retentionYears: number | null;
  active: boolean;
}
interface FolderRow {
  id: string;
  clientId: string | null;
  parentId: string | null;
  name: string;
}
interface State {
  docs: Record<string, DocRow>;
  versions: VersionRow[];
  types: Record<string, TypeRow>;
  folders: Record<string, FolderRow>;
  events: Array<Record<string, unknown>>;
}

class FakeDb {
  state: State = { docs: {}, versions: [], types: {}, folders: {}, events: [] };
  transactions = 0;
  failFolderUpdate = new Set<string>();
  /** Reihenfolge von Blocksperren und Audit-Events (Deadlock-Vermeidung). */
  trace: string[] = [];

  async run<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const snapshot = structuredClone(this.state);
    const events: Array<Record<string, unknown>> = [];
    try {
      const result = await fn(this.tx(events));
      this.state.events.push(...events);
      return result;
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private tx(events: Array<Record<string, unknown>>) {
    const s = () => this.state;
    const latest = (documentId: string) =>
      s()
        .versions.filter((version) => version.documentId === documentId)
        .sort((a, b) => b.versionNo - a.versionNo)[0] ?? null;
    return {
      __events: events,
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('= ANY(')) {
          const ids = values[1] as string[];
          const table = sql.includes('risk_research_result')
            ? 'research'
            : sql.includes('document_folder')
              ? 'folder'
              : 'document';
          this.trace.push(`lock:${table}:${ids.join(',')}`);
          return ids.map((id) => ({ id }));
        }
        if (sql.includes('FOR KEY SHARE')) {
          this.trace.push(`lock:target:${values[1] as string}`);
          return [];
        }
        const doc = s().docs[values[0] as string];
        if (sql.includes('FOR UPDATE OF d')) {
          return doc
            ? [
                {
                  id: doc.id,
                  title: doc.title,
                  classification: doc.classification,
                  clientId: doc.clientId,
                  deletedAt: doc.deletedAt,
                  gwgDestroyedAt: doc.gwgDestroyedAt,
                },
              ]
            : [];
        }
        if (sql.includes('gwg_id_document')) return [{ linked: doc?.gwgLinked ?? false }];
        if (sql.includes('FROM document_type')) {
          const type = s().types[values[0] as string];
          return type?.active
            ? [
                {
                  tier: type.tier,
                  classificationKey: type.classificationKey,
                  retentionYears: type.retentionYears,
                },
              ]
            : [];
        }
        if (sql.includes('FROM document') && sql.includes('FOR UPDATE')) {
          return doc && !doc.deletedAt
            ? [
                {
                  id: doc.id,
                  clientId: doc.clientId,
                  classification: doc.classification,
                  documentTypeId: doc.documentTypeId,
                },
              ]
            : [];
        }
        throw new Error(`FakeDb: unerwartetes SQL ${sql}`);
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const { storageJournal } =
          await import('@/server/documents/__tests__/storage-journal-fake');
        return storageJournal.executeRaw(strings, ...values);
      },
      document: {
        findFirst: async ({ where }: { where: { id: string; deletedAt?: null } }) => {
          const doc = s().docs[where.id];
          if (!doc || (where.deletedAt === null && doc.deletedAt)) return null;
          const type = doc.documentTypeId ? s().types[doc.documentTypeId] : undefined;
          const version = latest(doc.id);
          return {
            ...doc,
            documentType: type ? { tier: type.tier, retentionYears: type.retentionYears } : null,
            versions: version ? [version] : [],
          };
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<DocRow> }) => {
          const doc = s().docs[where.id]!;
          if (doc.payroll && data.sharedWithClientAt) {
            // app.guard_document_payroll_scope (RAISE EXCEPTION)
            throw Object.assign(new Error('payroll archive cannot be shared'), {
              code: 'P2010',
            });
          }
          Object.assign(doc, data);
          return doc;
        },
      },
      riskResearchResult: { updateMany: async () => ({ count: 0 }) },
      documentType: {
        findFirst: async ({
          where,
        }: {
          where: { id?: string; classificationKey?: string; active?: boolean };
        }) =>
          Object.values(s().types).find(
            (type) =>
              type.active &&
              (where.id
                ? type.id === where.id
                : type.classificationKey === where.classificationKey),
          ) ?? null,
      },
      documentVersion: {
        findFirst: async ({ where }: { where: { documentId: string } }) => latest(where.documentId),
        update: async ({ where, data }: { where: { id: string }; data: Partial<VersionRow> }) => {
          const version = s().versions.find((candidate) => candidate.id === where.id)!;
          Object.assign(version, data);
          return version;
        },
        create: async ({ data }: { data: Omit<VersionRow, 'id'> }) => {
          const version = { ...data, id: `version-${s().versions.length + 1}` } as VersionRow;
          s().versions.push(version);
          return version;
        },
      },
      documentFolder: {
        findFirst: async ({ where }: { where: { id: string } }) => s().folders[where.id] ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<FolderRow> }) => {
          if (this.failFolderUpdate.has(where.id)) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            });
          }
          Object.assign(s().folders[where.id]!, data);
          return s().folders[where.id];
        },
      },
    };
  }
}

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => m.db.run(fn),
}));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    fetchObjectBytes: m.fetchObjectBytes,
    prepareBytesCommitWithTier: storageJournal.prepare,
    commitPreparedBytes: storageJournal.commit,
    deleteObject: m.deleteObject,
    deleteObjectVersion: m.deleteObjectVersion,
    classificationToTier: (classification: string) =>
      classification.startsWith('GOBD_')
        ? 'GOBD'
        : classification === 'GWG_EVIDENCE'
          ? 'GWG'
          : 'NONE',
    gobdRetentionYears: () => 10,
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/container', () => ({
  evidenceService: {
    record: async (tx: { __events: unknown[] }, event: { resourceId: string }) => {
      m.db.trace.push(`audit:${event.resourceId}`);
      tx.__events.push(event);
      return {};
    },
  },
}));
vi.mock('@/server/storage/document-type', () => ({
  carrierClassification: (_tier: string, key: string | null) => key ?? 'GENERAL',
}));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: m.assertClientAccessTx,
  toActionError: (error: unknown) => {
    if (error instanceof m.ActionError || error instanceof m.ForbiddenError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: 'Datenbankfehler.' };
  },
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: m.ActionError,
  staffActionGuard: m.staffActionGuard,
  withStaff: vi.fn(),
}));

import {
  retagDocumentsAction,
  setDocumentsShareAction,
  softDeleteDocumentsAction,
} from '../actions';
import { moveDocumentItemsAction } from '../folder-actions';
import { DOCUMENT_BULK_MAX } from '@/server/documents/document-bulk';
import { storageJournal } from '@/server/documents/__tests__/storage-journal-fake';

const SESSION = { user: { tenantId: 'tenant-1', staffId: 'staff-1' } };
const CLIENT_1 = 'client-1';
const CLIENT_2 = 'client-2';
const CLIENT_SECRET = 'client-geheim';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string];
const TYPE_GENERAL = id(101);
const TYPE_LETTERS = id(102);
const TYPE_INVOICE = id(103);
const FOLDER_ROOT = id(201);
const FOLDER_CHILD = id(202);
const FOLDER_OTHER = id(203);
const FOLDER_TARGET = id(204);

function doc(docId: string, overrides: Partial<DocRow> = {}): DocRow {
  return {
    id: docId,
    title: `Dokument ${docId.slice(-2)}`,
    classification: 'GENERAL',
    clientId: CLIENT_1,
    folderId: null,
    documentTypeId: TYPE_GENERAL,
    createdAt: new Date('2026-01-10T00:00:00Z'),
    deletedAt: null,
    deletedByStaff: null,
    deleteReason: null,
    gwgDestroyedAt: null,
    sharedWithClientAt: null,
    sharedByStaff: null,
    retentionUntil: null,
    gwgLinked: false,
    payroll: false,
    ...overrides,
  };
}

function seed(docs: DocRow[], scanStatus: Record<string, string> = {}) {
  for (const row of docs) {
    m.db.state.docs[row.id] = row;
    m.db.state.versions.push({
      id: `v-${row.id}`,
      documentId: row.id,
      versionNo: 1,
      storageBucket: 'general',
      storageKey: `key-${row.id}`,
      storageVersionId: null,
      immutable: false,
      scanStatus: scanStatus[row.id] ?? 'CLEAN',
    });
  }
}

const events = (action?: string) =>
  m.db.state.events.filter((event) => !action || event['action'] === action);

beforeEach(() => {
  vi.clearAllMocks();
  m.db = new FakeDb();
  m.db.state.types = {
    [TYPE_GENERAL]: {
      id: TYPE_GENERAL,
      tier: 'NONE',
      classificationKey: 'GENERAL',
      retentionYears: null,
      active: true,
    },
    [TYPE_LETTERS]: {
      id: TYPE_LETTERS,
      tier: 'NONE',
      classificationKey: null,
      retentionYears: null,
      active: true,
    },
    [TYPE_INVOICE]: {
      id: TYPE_INVOICE,
      tier: 'GOBD',
      classificationKey: 'GOBD_INVOICE',
      retentionYears: 10,
      active: true,
    },
  };
  storageJournal.reset();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: SESSION,
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  m.assertClientAccessTx.mockImplementation(async (_tx, _session, clientId: string) => {
    if (clientId === CLIENT_SECRET)
      throw new m.ForbiddenError('Kein Zugriff auf diesen Mandanten.');
  });
  m.fetchObjectBytes.mockResolvedValue(Buffer.from('%PDF-1.7 Bestand'));
});

describe('softDeleteDocumentsAction', () => {
  it('blendet die Auswahl in einer Transaktion aus, mit Audit je Dokument und einer Revalidierung', async () => {
    seed([
      doc(A),
      doc(B, { gwgLinked: true, classification: 'GWG_EVIDENCE' }),
      doc(C, { clientId: null }),
      doc(D, { clientId: CLIENT_SECRET }),
    ]);

    const result = await softDeleteDocumentsAction({
      documentIds: [D, C, B, A],
      reason: '  Dublette ',
    });

    expect(result).toEqual({
      ok: false,
      done: 2,
      rejected: [
        { id: B, error: expect.stringContaining('bereits einer GwG-Prüfung zugeordnet') },
        { id: D, error: 'Kein Zugriff auf diesen Mandanten.' },
      ],
    });
    expect(m.db.transactions).toBe(1);
    // Alle Zeilen des Blocks gesperrt, bevor das erste Audit-Event den
    // tenantweiten Audit-Lock nimmt (gleiche Reihenfolge wie Einzel-Actions).
    expect(m.db.trace).toEqual([
      `lock:document:${[A, B, C, D].join(',')}`,
      `lock:research:${[A, B, C, D].join(',')}`,
      `audit:${A}`,
      `audit:${C}`,
    ]);
    expect(events('document.delete')).toEqual([
      expect.objectContaining({
        resourceId: A,
        after: expect.objectContaining({ reason: 'Dublette' }),
        // R-12: Mandant und Akteur aus dem Gate-Kontext (audit(tx, g, …)).
        tenantId: 'tenant-1',
        actorType: 'STAFF',
        actorId: 'staff-1',
      }),
      expect.objectContaining({
        resourceId: C,
        after: expect.objectContaining({ reason: 'Dublette' }),
      }),
    ]);
    expect(m.db.state.docs[A]!.deletedAt).toBeInstanceOf(Date);
    expect(m.db.state.docs[B]!.deletedAt).toBeNull();
    expect(m.db.state.docs[D]!.deletedAt).toBeNull();
    // Zugriff je Mandant einmal je Transaktion (A und B gehören zu client-1).
    expect(m.assertClientAccessTx.mock.calls.map(([, , clientId]) => clientId)).toEqual([
      CLIENT_1,
      CLIENT_SECRET,
    ]);
    expect(m.revalidatePath.mock.calls).toEqual([
      ['/staff/documents'],
      [`/staff/clients/${CLIENT_1}`],
    ]);
  });

  it('lehnt eine leere oder zu große Auswahl vor jeder Transaktion ab', async () => {
    const tooMany = Array.from({ length: DOCUMENT_BULK_MAX + 1 }, (_, n) => id(n + 1000));
    for (const documentIds of [[], tooMany, ['keine-uuid']]) {
      await expect(softDeleteDocumentsAction({ documentIds })).resolves.toEqual({
        ok: false,
        done: 0,
        rejected: [],
        error: 'Ungültige Dokumentauswahl.',
      });
    }
    expect(m.db.transactions).toBe(0);
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it('gibt den Fehler des Sitzungs-Gates unverändert zurück', async () => {
    m.staffActionGuard.mockResolvedValueOnce({ ok: false, error: 'Nicht eingeloggt.' });
    await expect(softDeleteDocumentsAction({ documentIds: [A] })).resolves.toEqual({
      ok: false,
      done: 0,
      rejected: [],
      error: 'Nicht eingeloggt.',
    });
    expect(m.db.transactions).toBe(0);
  });
});

describe('setDocumentsShareAction', () => {
  it('gibt frei mit Zugriff und Audit je Dokument; ein Triggerfehler blockiert die übrigen nicht', async () => {
    seed([
      doc(A),
      doc(B, { payroll: true }),
      doc(C, { clientId: null }),
      doc(D, { clientId: CLIENT_2 }),
    ]);

    const result = await setDocumentsShareAction({ documentIds: [A, B, C, D], share: true });

    expect(result).toEqual({
      ok: false,
      done: 2,
      rejected: [
        { id: B, error: 'Datenbankfehler.' },
        { id: C, error: 'Nur Mandanten-Dokumente können freigegeben werden.' },
      ],
    });
    // Block (am Trigger gescheitert, zurückgerollt) + je Dokument eine Transaktion.
    expect(m.db.transactions).toBe(1 + 4);
    // Audit genau einmal je tatsächlich freigegebenem Dokument.
    expect(events()).toEqual([
      expect.objectContaining({ action: 'document.share', resourceId: A }),
      expect.objectContaining({ action: 'document.share', resourceId: D }),
    ]);
    expect(m.db.state.docs[A]!.sharedWithClientAt).toBeInstanceOf(Date);
    expect(m.db.state.docs[B]!.sharedWithClientAt).toBeNull();
    expect(m.revalidatePath.mock.calls).toEqual([
      ['/staff/documents'],
      [`/staff/clients/${CLIENT_1}`],
      [`/staff/clients/${CLIENT_2}`],
    ]);
  });

  it('zieht Freigaben in einer Transaktion zurück', async () => {
    const sharedAt = new Date('2026-09-01T00:00:00Z');
    seed([doc(A, { sharedWithClientAt: sharedAt }), doc(B, { sharedWithClientAt: sharedAt })]);

    await expect(setDocumentsShareAction({ documentIds: [A, B], share: false })).resolves.toEqual({
      ok: true,
      done: 2,
      rejected: [],
    });
    expect(m.db.transactions).toBe(1);
    expect(events('document.unshare')).toHaveLength(2);
    expect(m.db.state.docs[A]!.sharedWithClientAt).toBeNull();
  });

  it('revalidiert nicht, wenn nichts geändert wurde', async () => {
    seed([doc(A, { clientId: null })]);
    await setDocumentsShareAction({ documentIds: [A], share: true });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('moveDocumentItemsAction', () => {
  beforeEach(() => {
    m.db.state.folders = {
      [FOLDER_ROOT]: { id: FOLDER_ROOT, clientId: CLIENT_1, parentId: null, name: 'Steuern' },
      [FOLDER_CHILD]: { id: FOLDER_CHILD, clientId: CLIENT_1, parentId: FOLDER_ROOT, name: '2026' },
      [FOLDER_OTHER]: { id: FOLDER_OTHER, clientId: CLIENT_1, parentId: null, name: 'Verträge' },
      [FOLDER_TARGET]: {
        id: FOLDER_TARGET,
        clientId: CLIENT_1,
        parentId: FOLDER_CHILD,
        name: 'Ziel',
      },
    };
  });

  it('verschiebt Dokumente und Ordner in einer Transaktion mit Audit je Eintrag', async () => {
    seed([doc(A), doc(B, { clientId: CLIENT_2 })]);

    const result = await moveDocumentItemsAction({
      documentIds: [A, B],
      folderIds: [FOLDER_ROOT, FOLDER_OTHER],
      targetFolderId: FOLDER_TARGET,
    });

    expect(result).toEqual({
      ok: false,
      done: 2,
      rejected: [
        { id: B, error: 'Ordner gehört zu einem anderen Mandanten/Bereich.' },
        { id: FOLDER_ROOT, error: 'Zielordner liegt im eigenen Unterbaum.' },
      ],
    });
    expect(m.db.transactions).toBe(1);
    expect(m.db.trace.slice(0, 4)).toEqual([
      `lock:document:${[A, B].join(',')}`,
      `lock:folder:${[FOLDER_ROOT, FOLDER_OTHER].join(',')}`,
      `lock:target:${FOLDER_TARGET}`,
      `audit:${A}`,
    ]);
    expect(m.db.state.docs[A]!.folderId).toBe(FOLDER_TARGET);
    expect(m.db.state.folders[FOLDER_OTHER]!.parentId).toBe(FOLDER_TARGET);
    expect(m.db.state.folders[FOLDER_ROOT]!.parentId).toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ action: 'document.move_folder', resourceId: A }),
      expect.objectContaining({ action: 'document_folder.move', resourceId: FOLDER_OTHER }),
    ]);
    expect(m.revalidatePath.mock.calls).toEqual([
      ['/staff/documents'],
      [`/staff/clients/${CLIENT_1}`],
    ]);
  });

  it('meldet einen Namenskonflikt des Zielordners verständlich und verschiebt den Rest', async () => {
    seed([doc(A)]);
    m.db.failFolderUpdate.add(FOLDER_OTHER);

    const result = await moveDocumentItemsAction({
      documentIds: [A],
      folderIds: [FOLDER_OTHER],
      targetFolderId: null,
    });

    expect(result).toEqual({
      ok: false,
      done: 1,
      rejected: [
        {
          id: FOLDER_OTHER,
          error: 'Auf dieser Ebene gibt es bereits einen Ordner mit diesem Namen.',
        },
      ],
    });
    expect(m.db.state.docs[A]!.folderId).toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ action: 'document.move_folder', resourceId: A }),
    ]);
  });
});

describe('retagDocumentsAction', () => {
  it('ändert reine Metadaten der Auswahl in einer Transaktion und meldet Sperren je Dokument', async () => {
    seed(
      [
        doc(A),
        doc(B),
        doc(C),
        doc(D, { documentTypeId: TYPE_LETTERS }),
        doc(E, { classification: 'GOBD_INVOICE', documentTypeId: TYPE_INVOICE }),
      ],
      { [C]: 'PENDING' },
    );

    const result = await retagDocumentsAction({
      documentIds: [A, B, C, D, E],
      documentTypeId: TYPE_LETTERS,
    });

    expect(result).toEqual({
      ok: false,
      // A, B geändert; D hat den Zieltyp schon (unverändert erledigt).
      done: 3,
      rejected: [
        {
          id: C,
          error:
            'Dokument-Upload ist noch nicht abgeschlossen. Bitte zuerst den Upload fortsetzen.',
        },
        { id: E, error: expect.stringContaining('Herabstufung nicht möglich') },
      ],
    });
    // Ziel, Stand aller Dokumente, alle Metadatenänderungen: je eine Transaktion.
    expect(m.db.transactions).toBe(3);
    expect(events('document.retag')).toEqual([
      expect.objectContaining({
        resourceId: A,
        after: expect.objectContaining({ reStored: false }),
      }),
      expect.objectContaining({
        resourceId: B,
        after: expect.objectContaining({ reStored: false }),
      }),
    ]);
    expect(m.db.state.docs[A]!.documentTypeId).toBe(TYPE_LETTERS);
    expect(storageJournal.events).toEqual([]);
    expect(m.revalidatePath.mock.calls).toEqual([
      ['/staff/documents'],
      [`/staff/clients/${CLIENT_1}`],
    ]);
  });

  it('meldet einen unbekannten Zieltyp vor jeder Dokumentverarbeitung', async () => {
    seed([doc(A)]);
    await expect(
      retagDocumentsAction({ documentIds: [A], documentTypeId: id(999) }),
    ).resolves.toEqual({ ok: false, done: 0, rejected: [], error: 'Datei-Typ nicht gefunden.' });
    expect(m.db.transactions).toBe(1);
  });

  it('stuft je Dokument journal-first hoch und reicht Re-Stores nach dem Zeitbudget nach', async () => {
    seed([doc(A), doc(B)]);
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    m.fetchObjectBytes.mockImplementation(async () => {
      // Der erste Re-Store verbraucht das ganze Budget des Aufrufs.
      now += 25_000;
      return Buffer.from('%PDF-1.7 Bestand');
    });

    try {
      const first = await retagDocumentsAction({
        documentIds: [A, B],
        documentTypeId: TYPE_INVOICE,
      });
      expect(first).toEqual({ ok: false, done: 1, rejected: [], pending: [B] });
      expect(storageJournal.rows).toEqual([
        expect.objectContaining({ source: 'staff.document.retag', resolution: 'REFERENCED' }),
      ]);
      expect(m.revalidatePath).toHaveBeenCalledWith('/staff/documents');

      const second = await retagDocumentsAction({
        documentIds: first.pending!,
        documentTypeId: TYPE_INVOICE,
      });
      expect(second).toEqual({ ok: true, done: 1, rejected: [] });
    } finally {
      clock.mockRestore();
    }

    expect(events('document.retag')).toEqual([
      expect.objectContaining({
        resourceId: A,
        after: expect.objectContaining({ reStored: true }),
      }),
      expect.objectContaining({
        resourceId: B,
        after: expect.objectContaining({ reStored: true }),
      }),
    ]);
    expect(storageJournal.openIntents()).toEqual([]);
    expect(m.db.state.docs[B]!.classification).toBe('GOBD_INVOICE');
    // Ungeschützte Altobjekte werden nach dem Commit best-effort entfernt.
    expect(m.deleteObject.mock.calls).toEqual([
      ['general', `key-${A}`],
      ['general', `key-${B}`],
    ]);
  });
});
