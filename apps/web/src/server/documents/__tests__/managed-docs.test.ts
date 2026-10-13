// Ein Dokument-DTO für beide Explorer-Varianten. Die Nutzung durch
// /staff/documents, den Mandanten-Tab und das Aktenregal wird über die
// gelieferten Daten geprüft statt über den Quelltext (B-08, Welle 15).
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Entry, ManagedDoc as ExplorerManagedDoc } from '@/components/document-explorer';

const h = vi.hoisted(() => ({
  tx: {
    client: { findFirst: vi.fn() },
    documentFolder: { findMany: vi.fn() },
    document: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  },
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, run: (tx: unknown) => unknown) => run(h.tx)),
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: async () => ({}),
  canAccessClientTx: async () => true,
}));
vi.mock('@/server/request-creation-options', () => ({ readRequestCreationOptionsTx: vi.fn() }));
vi.mock('@/server/mail/delivery-status', () => ({ loadMailDeliveryTx: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/components/document-explorer', () => ({ DocumentExplorer: () => null }));

import {
  MANAGED_DOC_SELECT,
  documentTier,
  loadAnalysisDocuments,
  toManagedDoc,
  type ManagedDoc,
  type ManagedDocRow,
} from '../managed-docs';
import DocumentsPage from '@/app/staff/(protected)/documents/page';
import { loadClientDocumentsPage } from '@/app/staff/(protected)/clients/[id]/_data';

const ROW: ManagedDocRow = {
  id: 'doc-1',
  title: 'Rechnung 2026-0001',
  mimeType: 'application/pdf',
  classification: 'GOBD_INVOICE',
  documentTypeId: null,
  documentType: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  folderId: 'folder-1',
  deletedAt: null,
  sharedWithClientAt: new Date('2026-09-02T10:00:00.000Z'),
  versions: [{ sizeBytes: 2048n }],
};

describe('ein Dokument-DTO für beide Explorer-Varianten', () => {
  it('leitet die Schutzstufe aus dem Typ, sonst aus der Klassifikation ab', () => {
    expect(documentTier('GENERAL', 'GOBD')).toBe('GOBD');
    expect(documentTier('GOBD_TAX', null)).toBe('GOBD');
    expect(documentTier('GOBD_CONTRACT', undefined)).toBe('GOBD');
    expect(documentTier('GWG_EVIDENCE', null)).toBe('GWG');
    expect(documentTier('GENERAL', null)).toBe('NONE');
  });

  it('bildet die Dokumentzeile vollständig ab', () => {
    expect(toManagedDoc(ROW)).toEqual({
      id: 'doc-1',
      title: 'Rechnung 2026-0001',
      mimeType: 'application/pdf',
      classification: 'GOBD_INVOICE',
      typeName: '',
      typeId: null,
      tier: 'GOBD',
      sizeBytes: 2048,
      createdAt: '2026-09-01T10:00:00.000Z',
      folderId: 'folder-1',
      deletedAt: null,
      shared: true,
    });
    expect(MANAGED_DOC_SELECT.mimeType).toBe(true);
  });

  it('liefert der Explorer denselben DTO-Typ (kein zweites ManagedDoc)', () => {
    expectTypeOf<ExplorerManagedDoc>().toEqualTypeOf<ManagedDoc>();
  });
});

// GwG-Beleg ohne Typ (Stufe aus der Klassifikation) und typisiertes Dokument
// (Stufe aus dem Typ) – ein eigener Tier-Mapper eines Aufrufers fiele auf.
const GWG_ROW: ManagedDocRow = {
  ...ROW,
  id: 'doc-2',
  title: 'Ausweiskopie',
  classification: 'GWG_EVIDENCE',
  sharedWithClientAt: null,
  versions: [],
};
const TYPED_ROW: ManagedDocRow = {
  ...ROW,
  id: 'doc-3',
  title: 'Arbeitsvertrag',
  classification: 'GENERAL',
  documentTypeId: 'type-1',
  documentType: { name: 'Vertrag', tier: 'GOBD' },
};
const EXPECTED: ManagedDoc[] = [
  {
    id: 'doc-2',
    title: 'Ausweiskopie',
    mimeType: 'application/pdf',
    classification: 'GWG_EVIDENCE',
    typeName: '',
    typeId: null,
    tier: 'GWG',
    sizeBytes: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    folderId: 'folder-1',
    deletedAt: null,
    shared: false,
  },
  {
    id: 'doc-3',
    title: 'Arbeitsvertrag',
    mimeType: 'application/pdf',
    classification: 'GENERAL',
    typeName: 'Vertrag',
    typeId: 'type-1',
    tier: 'GOBD',
    sizeBytes: 2048,
    createdAt: '2026-09-01T10:00:00.000Z',
    folderId: 'folder-1',
    deletedAt: null,
    shared: true,
  },
];

describe('/staff/documents, Mandanten-Tab und Aktenregal nutzen Select und Mapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      name: 'Muster GmbH',
      kind: 'JURPERS',
    });
    h.tx.documentFolder.findMany.mockResolvedValue([]);
    h.tx.document.findMany.mockResolvedValue([GWG_ROW, TYPED_ROW]);
    h.tx.document.findFirst.mockResolvedValue(null);
    h.tx.document.count.mockResolvedValue(2);
    h.tx.document.groupBy.mockResolvedValue([]);
  });

  it('/staff/documents', async () => {
    const element = (await DocumentsPage({
      searchParams: Promise.resolve({ type: 'INTERNAL' }),
    })) as ReactElement<{ entries: Entry[] }>;
    expect(h.tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: MANAGED_DOC_SELECT }),
    );
    expect(element.props.entries).toEqual(EXPECTED.map((doc) => ({ kind: 'file', ...doc })));
  });

  it('Mandanten-Tab', async () => {
    const result = await loadClientDocumentsPage(
      { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      { user: { tenantId: 'tenant-1', staffId: 'staff-1' } } as never,
      'client-1',
      { page: 1, deleted: false, folder: 'all', q: '' },
    );
    expect(h.tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: MANAGED_DOC_SELECT }),
    );
    expect(result?.documents).toEqual(EXPECTED);
  });

  it('Aktenregal', async () => {
    const documents = await loadAnalysisDocuments(
      { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      'analysis-1',
    );
    expect(h.tx.document.findMany).toHaveBeenCalledWith({
      where: { analysisId: 'analysis-1' },
      orderBy: { createdAt: 'desc' },
      select: MANAGED_DOC_SELECT,
    });
    expect(documents).toEqual(EXPECTED);
  });
});
