// Fachkatalog: CLIENT-ASSISTANCE-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Fachkatalog: DOC-PORTAL-SHARING-001
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  tx: {} as Record<string, unknown>,
  persist: vi.fn(),
  guard: vi.fn(),
}));
vi.mock('@taxtronik/storage', () => ({ s3: { send: mocks.send } }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
}));
vi.mock('@/server/auth/rbac', () => ({ ActionError: class extends Error {} }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: vi.fn().mockResolvedValue({ ok: true }),
  checkPortalWriteLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/server/documents/resumable-upload', () => ({
  persistResumableDocumentUpload: mocks.persist,
  ResumableDocumentUploadError: class extends Error {},
}));
vi.mock('../service', () => ({
  assistanceAccess: async () => ({
    ctx: { tenantId: 'tenant', actorId: 'actor', actorType: 'STAFF' },
    guardMutationTx: mocks.guard,
  }),
  assistanceDocumentWhere: (_surface: string, tenantId: string, clientId: string) => ({
    tenantId,
    clientId,
    deletedAt: null,
  }),
}));
import {
  archiveAssistance,
  readAssistanceBytes,
  assistanceRevisionTx,
  assistanceVersionTx,
} from '../outputs';
import { buildAssistanceSnapshot, assistanceSnapshotHash } from '../snapshot';
import type { TxClient } from '@taxtronik/db';
const id = '11111111-1111-4111-8111-111111111111';
const snapshot = buildAssistanceSnapshot(
  {
    id,
    title: 'Case',
    kind: 'PROCEDURE',
    revision: 1,
    status: 'SUBMITTED',
    answers: {},
    schemaSnapshot: { title: 'Original', version: 1, fields: [] },
    sourceDocumentVersionId: null,
    sourceHash: null,
    externalDocumentVersionId: null,
    externalDocumentHash: null,
    confirmedAt: null,
    reviewNote: null,
    reviewedByStaff: null,
  },
  new Date('2026-01-01Z'),
);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue(undefined);
});
describe('CLIENT-ASSISTANCE-001 / DOC-UPLOAD-JOURNAL-001 exact stored output', () => {
  it('resumes the existing pending document instead of reserving another artifact', async () => {
    const create = vi.fn();
    mocks.tx = {
      clientAssistanceRevision: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'revision',
          snapshot,
          snapshotHash: assistanceSnapshotHash(snapshot),
        }),
      },
      clientAssistanceOutput: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'output',
          status: 'PENDING',
          snapshotHash: assistanceSnapshotHash(snapshot),
          documentVersionId: 'version',
          documentVersion: {
            documentId: 'stable-document',
            document: { sharedWithClientAt: null },
          },
        }),
        create,
      },
    };
    await archiveAssistance('staff', {
      id,
      clientId: id,
      kind: 'PROCEDURE',
      revision: 1,
      format: 'pdf',
    });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeDocumentId: 'stable-document',
        storage: expect.objectContaining({
          tier: 'GOBD',
          retentionAnchor: new Date(snapshot.occurredAt),
        }),
      }),
    );
  });
  it('fails closed when stored revision content no longer matches its recorded hash', async () => {
    const tx = {
      clientAssistanceRevision: {
        findFirst: vi.fn().mockResolvedValue({
          snapshot: { ...snapshot, reviewNote: 'forged' },
          snapshotHash: assistanceSnapshotHash(snapshot),
        }),
      },
    } as unknown as TxClient;
    await expect(assistanceRevisionTx(tx, id, id, 'PROCEDURE', 1)).rejects.toThrow(
      'nicht konsistent',
    );
  });
  it('rejects another source hash even when a UUID resolved to a document', async () => {
    const tx = {
      documentVersion: { findFirst: vi.fn().mockResolvedValue({ sha256: Buffer.alloc(32, 1) }) },
    } as unknown as TxClient;
    await expect(
      assistanceVersionTx(tx, 'staff', 'tenant', id, id, '0'.repeat(64)),
    ).rejects.toThrow('nicht verfügbar');
  });
  it('loads the exact object-store version and verifies its bytes', async () => {
    const bytes = Buffer.from('fixed bytes');
    mocks.send.mockResolvedValue({ ContentLength: bytes.length, Body: Readable.from([bytes]) });
    await expect(
      readAssistanceBytes({
        storageBucket: 'bucket',
        storageKey: 'key',
        storageVersionId: 'exact-version',
        sizeBytes: BigInt(bytes.length),
        sha256: createHash('sha256').update(bytes).digest(),
      }),
    ).resolves.toEqual(bytes);
    expect(mocks.send.mock.calls[0]![0].input.VersionId).toBe('exact-version');
  });
  it('rejects truncated or tampered bytes and never returns a partial artifact', async () => {
    mocks.send.mockResolvedValue({ ContentLength: 3, Body: Readable.from([Buffer.from('bad')]) });
    await expect(
      readAssistanceBytes({
        storageBucket: 'bucket',
        storageKey: 'key',
        storageVersionId: null,
        sizeBytes: 3n,
        sha256: createHash('sha256').update('yes').digest(),
      }),
    ).rejects.toThrow('Integritätsprüfung');
  });
});
