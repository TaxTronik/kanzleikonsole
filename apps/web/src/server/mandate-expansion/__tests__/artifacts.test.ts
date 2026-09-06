// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: CLIENT-OFFBOARDING-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { MandateArtifact } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
const mocks = vi.hoisted(() => ({
  tx: {} as Record<string, unknown>,
  persist: vi.fn(),
  structure: vi.fn(),
  access: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
}));
vi.mock('@taxtronik/storage', () => ({
  classificationToTier: (classification: string) =>
    classification === 'GWG_EVIDENCE' ? 'GWG' : 'NONE',
}));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: async () => ({
    ok: true,
    staffId: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant',
    ctx: { tenantId: 'tenant' },
    session: { user: { tenantId: 'tenant', staffId: '11111111-1111-4111-8111-111111111111' } },
  }),
}));
vi.mock('@/server/auth/rbac', () => ({
  ActionError: class extends Error {},
  assertClientAccessTx: mocks.access,
  isStaffAdmin: () => true,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/rate-limit', () => ({ checkStaffExportLimit: async () => ({ ok: true }) }));
vi.mock('@/server/documents/resumable-upload', () => ({
  persistResumableDocumentUpload: mocks.persist,
  ResumableDocumentUploadError: class extends Error {},
}));
vi.mock('@/server/client-assistance/outputs', () => ({
  readAssistanceBytes: async () => Buffer.from('exact bytes'),
}));
vi.mock('../service', () => ({ loadStructureTx: mocks.structure }));
import {
  handoverGroups,
  handoverPreparationHash,
  assertMandateArtifactTx,
  archiveStructure,
  archiveOffboarding,
} from '../artifacts';
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-08-31T01:00:00Z'),
  hash = 'a'.repeat(64);
const document = {
  versionId: a,
  documentId: b,
  title: 'Freigegebene Fassung',
  mimeType: 'application/pdf',
  classification: 'GWG_EVIDENCE',
  requiresPayrollAccess: false,
  sha256: hash,
  sizeBytes: '100',
  approvedBy: a,
  approvedAt: at.toISOString(),
  sensitiveApproved: true,
};
const base = {
  sourceHash: hash,
  recipient: 'Empfänger Kanzlei, Markt 1',
  endDate: at,
  handoverNote: 'Fristen geprüft',
  retentionNote: 'Einzelfälle offen',
  documents: [{ documentVersionId: a, approvedBy: a, approvedAt: at, sensitiveApproved: true }],
};
const snapshot = {
  version: 1,
  clientId: a,
  clientName: 'Mandat',
  recipient: base.recipient,
  endDate: '2026-08-31',
  sourceHash: hash,
  handoverNote: base.handoverNote,
  retentionNote: base.retentionNote,
  deadlines: [],
  notices: [],
  documents: [document],
};
const artifact = {
  id: a,
  tenantId: 'tenant',
  clientId: a,
  kind: 'OFFBOARDING',
  structureVersionId: null,
  manifest: { snapshot },
} as unknown as MandateArtifact;
const source = {
  documentVersionId: a,
  sourceHash: hash,
  documentVersion: {
    id: a,
    sha256: Buffer.from(hash, 'hex'),
    scanStatus: 'CLEAN',
    scanCompletedAt: at,
    document: {
      id: b,
      clientId: a,
      tenantId: 'tenant',
      classification: 'GWG_EVIDENCE',
      requiresPayrollAccess: false,
    },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue(undefined);
});
describe('CLIENT-OFFBOARDING-001 archived releases and protection boundaries', () => {
  it('keeps every protection class separate and splits oversized aggregate groups without omitting sources', () => {
    const docs = [
      { ...document, sizeBytes: String(13 * 1024 * 1024) },
      { ...document, versionId: b, sizeBytes: String(13 * 1024 * 1024) },
      {
        ...document,
        versionId: '33333333-3333-4333-8333-333333333333',
        classification: 'GOBD_TAX',
      },
      {
        ...document,
        versionId: '44444444-4444-4444-8444-444444444444',
        classification: 'PERSONNEL',
      },
    ];
    const groups = handoverGroups(docs);
    expect(groups).toHaveLength(4);
    expect(groups.flatMap((g) => g.documents)).toHaveLength(4);
    expect(groups.find((g) => g.classification === 'PERSONNEL')?.payroll).toBe(true);
    expect(() => handoverGroups([{ ...document, sizeBytes: String(25 * 1024 * 1024) }])).toThrow(
      '24 MiB',
    );
  });
  it('binds recipient and individual sensitive approvals into the preparation hash', () => {
    expect(handoverPreparationHash(base)).not.toBe(
      handoverPreparationHash({ ...base, recipient: 'Andere Kanzlei, Markt 2' }),
    );
    expect(handoverPreparationHash(base)).not.toBe(
      handoverPreparationHash({
        ...base,
        documents: [{ ...base.documents[0]!, sensitiveApproved: false }],
      }),
    );
  });
  it('fails closed after a source is destroyed or reclassified, even if its UUID and bytes were once valid', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ allowed: true }]),
      mandateArtifactSource: {
        findMany: vi.fn().mockResolvedValue([{ ...source, documentVersion: null }]),
      },
    };
    const session = { user: { tenantId: 'tenant' } } as StaffSession;
    await expect(
      assertMandateArtifactTx(db as unknown as TxClient, session, artifact),
    ).rejects.toThrow('vernichteter');
    db.mandateArtifactSource.findMany.mockResolvedValue([
      {
        ...source,
        documentVersion: {
          ...source.documentVersion,
          document: { ...source.documentVersion.document, requiresPayrollAccess: true },
        },
      },
    ] as never);
    await expect(
      assertMandateArtifactTx(db as unknown as TxClient, session, artifact),
    ).rejects.toThrow('Schutzklasse');
  });
  it('rejects a missing manifest source instead of generating a partial package', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ allowed: true }]),
      mandateArtifactSource: { findMany: vi.fn().mockResolvedValue([]) },
    };
    await expect(
      assertMandateArtifactTx(db as unknown as TxClient, {} as StaffSession, artifact),
    ).rejects.toThrow('unvollständig');
  });
  it('archives GwG originals and the protocol through private GWG storage, preserving a pending document on retry', async () => {
    const run = {
      ...base,
      id: b,
      tenantId: 'tenant',
      clientId: a,
      sourceSnapshot: { clientName: 'Mandat', deadlines: [], notices: [] },
      documents: [
        {
          ...base.documents[0]!,
          documentVersion: {
            ...source.documentVersion,
            documentId: b,
            sizeBytes: 100n,
            document: {
              ...source.documentVersion.document,
              title: document.title,
              mimeType: document.mimeType,
            },
          },
        },
      ],
    };
    let seq = 0;
    mocks.tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ allowed: true }]),
      mandateOffboarding: { findFirst: vi.fn().mockResolvedValue(run) },
      mandateArtifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => ({
          ...data,
          id: String(++seq),
          status: 'RESERVED',
          createdAt: at,
          documentId: null,
          documentVersionId: null,
        })),
      },
      mandateArtifactSource: { createMany: vi.fn() },
    };
    await archiveOffboarding({ id: b, expectedHash: handoverPreparationHash(run) });
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    for (const [options] of mocks.persist.mock.calls)
      expect(options).toEqual(
        expect.objectContaining({
          documentData: expect.objectContaining({
            classification: 'GWG_EVIDENCE',
            requiresPayrollAccess: false,
            sharedWithClientAt: null,
          }),
          storage: expect.objectContaining({ tier: 'GWG' }),
        }),
      );
    const pending = {
      id: a,
      tenantId: 'tenant',
      clientId: a,
      structureVersionId: b,
      kind: 'STRUCTURE',
      status: 'PENDING',
      documentId: 'same-upload',
      documentVersionId: b,
      groupKey: 'PDF',
      sourceHash: hash,
      classification: 'STAFF_PRIVATE',
      requiresPayrollAccess: false,
    };
    mocks.structure.mockResolvedValue({ id: b, contentHash: hash, revision: 1 });
    mocks.tx = {
      mandateArtifact: { findFirst: vi.fn().mockResolvedValue(pending), create: vi.fn() },
    };
    await archiveStructure({ clientId: a, versionId: b });
    expect(mocks.persist).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resumeDocumentId: 'same-upload',
        documentData: expect.objectContaining({ sharedWithClientAt: null }),
      }),
    );
  });
});
