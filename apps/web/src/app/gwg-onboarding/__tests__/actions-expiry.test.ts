import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  headers: vi.fn(),
  checkRateLimit: vi.fn(),
  checkIpOrGlobalLimit: vi.fn(),
  withSystemContext: vi.fn(),
  revalidateInvite: vi.fn(),
  prepareBytesCommitWithTier: vi.fn(),
  commitPreparedBytes: vi.fn(),
  deleteObjectVersion: vi.fn(),
  createPendingDocumentWithVersion: vi.fn(),
  finalizePendingDocumentVersion: vi.fn(),
  findVersion: vi.fn(),
  deleteDocument: vi.fn(),
  evidenceRecord: vi.fn(),
  ensureGwgRootFolder: vi.fn(),
  ensureGwgPersonFolder: vi.fn(),
  queryRaw: vi.fn(),
  findInviteById: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: m.headers }));
vi.mock('@taxtronik/storage', () => ({
  prepareBytesCommitWithTier: m.prepareBytesCommitWithTier,
  commitPreparedBytes: m.commitPreparedBytes,
  deleteObjectVersion: m.deleteObjectVersion,
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: m.withSystemContext }));
vi.mock('@/server/container', () => ({
  evidenceService: { record: m.evidenceRecord },
}));
vi.mock('@/server/documents/upload-helpers', () => ({
  createPendingDocumentWithVersion: m.createPendingDocumentWithVersion,
  finalizePendingDocumentVersion: m.finalizePendingDocumentVersion,
}));
vi.mock('@/server/gwg-onboarding/invite-lifecycle', () => ({
  revalidateOpenGwgInviteRevisionTx: m.revalidateInvite,
  claimCurrentGwgInviteSubmitTx: vi.fn(),
}));
vi.mock('@/server/gwg-onboarding/document-folders', () => ({
  ensureGwgRootFolderTx: m.ensureGwgRootFolder,
  ensureGwgPersonFolderTx: m.ensureGwgPersonFolder,
}));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: vi.fn(() => ({ ok: false, error: 'Interner Fehler.' })),
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    gwgOnboardingInvite: {
      findFirst: m.findFirst,
      updateMany: m.updateMany,
    },
  },
}));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: m.checkRateLimit,
  checkIpOrGlobalLimit: m.checkIpOrGlobalLimit,
  getClientIp: vi.fn(() => '192.0.2.1'),
}));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/notifications/service', () => ({ notifyMany: vi.fn() }));

import { discardOnboardingUploadAction, uploadIdImageAction } from '../actions';
import { GENERIC_TOKEN_ERROR } from '@/server/gwg-onboarding/service';

describe('GwG-Onboarding Ablauf-CAS bei Schreibaktionen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.headers.mockResolvedValue(new Headers());
    m.checkRateLimit.mockResolvedValue({ ok: true });
    m.checkIpOrGlobalLimit.mockResolvedValue({ ok: true });
    m.withSystemContext.mockImplementation(
      async (_tenantId: string, fn: (tx: Record<string, unknown>) => unknown) =>
        fn({
          $executeRaw: vi.fn(),
          $queryRaw: m.queryRaw,
          document: { deleteMany: m.deleteDocument },
          documentVersion: { findUnique: m.findVersion },
          gwgOnboardingInvite: { findUnique: m.findInviteById },
        }),
    );
    m.ensureGwgRootFolder.mockResolvedValue('gwg-folder-1');
    m.ensureGwgPersonFolder.mockResolvedValue('gwg-person-folder-1');
    m.deleteObjectVersion.mockResolvedValue(undefined);
    m.prepareBytesCommitWithTier.mockResolvedValue({
      tier: 'GWG',
      tenantId: 'tenant-1',
      targetBucket: 'taxtronik-gwg',
      targetKey: 'tenant-1/evidence.bin',
      sha256: Buffer.alloc(32),
      sizeBytes: 1n,
      immutable: true,
      retentionUntil: new Date('2099-01-01T00:00:00.000Z'),
      detectedMime: 'application/pdf',
    });
    m.createPendingDocumentWithVersion.mockResolvedValue({
      document: { id: 'document-pending' },
      version: { id: 'version-pending' },
    });
    m.findVersion.mockResolvedValue({
      documentId: 'document-pending',
      storageBucket: 'taxtronik-gwg',
      storageKey: 'tenant-1/evidence.bin',
      storageVersionId: null,
      scanStatus: 'PENDING',
    });
    m.deleteDocument.mockResolvedValue({ count: 1 });
    m.finalizePendingDocumentVersion.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bleibt fail-closed, ohne einen parallel geclaimten SUBMITTED-Invite zu ueberschreiben', async () => {
    const now = new Date('2030-01-02T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    m.findFirst.mockResolvedValueOnce({
      id: 'invite-1',
      tokenHash: 'token-hash',
      status: 'PENDING',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
      clientId: 'client-1',
      client: { id: 'client-1', kind: 'JURPERS' },
    });
    // Simuliert den gewonnenen Submit zwischen Lookup und Ablauf-Write.
    m.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      uploadIdImageAction({
        token: 'valid-looking-raw-token',
        fileName: 'ausweis.pdf',
        mimeType: 'application/pdf',
        base64: 'YQ==',
        kind: 'ID_DOCUMENT',
      }),
    ).resolves.toEqual({ ok: false, error: GENERIC_TOKEN_ERROR });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invite-1',
        status: { in: ['PENDING', 'STARTED'] },
        expiresAt: { lte: now },
      },
      data: { status: 'EXPIRED' },
    });
  });

  it('gibt bei einem Lookup-Fehler keine rohe Datenbankmeldung preis', async () => {
    m.findFirst.mockRejectedValueOnce(new Error('password authentication failed for db-user'));

    await expect(
      uploadIdImageAction({
        token: 'valid-looking-raw-token',
        fileName: 'ausweis.pdf',
        mimeType: 'application/pdf',
        base64: 'YQ==',
        kind: 'ID_DOCUMENT',
      }),
    ).resolves.toEqual({ ok: false, error: GENERIC_TOKEN_ERROR });
  });

  it('legt einen benannten Ausweis direkt im Personen-Unterordner an', async () => {
    m.findFirst.mockResolvedValueOnce({
      id: 'invite-1',
      tokenHash: 'token-hash',
      status: 'PENDING',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
      clientId: 'client-1',
      createdByStaff: 'staff-1',
      client: { id: 'client-1', kind: 'JURPERS' },
    });
    m.revalidateInvite.mockResolvedValue(true);
    m.commitPreparedBytes.mockResolvedValue({
      targetBucket: 'taxtronik-gwg',
      targetKey: 'tenant-1/evidence.bin',
      storageVersionId: 'version-123',
      sha256: Buffer.alloc(32),
      sizeBytes: 1n,
      immutable: true,
      retentionUntil: new Date('2099-01-01T00:00:00.000Z'),
      detectedMime: 'application/pdf',
    });

    await expect(
      uploadIdImageAction({
        token: 'valid-looking-raw-token',
        fileName: 'ausweis.pdf',
        mimeType: 'application/pdf',
        base64: 'YQ==',
        kind: 'ID_DOCUMENT',
        personName: 'Erika Muster',
      }),
    ).resolves.toEqual({ ok: true, documentId: 'document-pending' });

    expect(m.ensureGwgPersonFolder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rootFolderId: 'gwg-folder-1',
        personName: 'Erika Muster',
      }),
    );
    expect(m.createPendingDocumentWithVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        documentData: expect.objectContaining({ folderId: 'gwg-person-folder-1' }),
      }),
    );
  });

  it('löscht bei einem stale Link exakt die geschützte Objektversion mit Governance-Bypass', async () => {
    m.findFirst.mockResolvedValueOnce({
      id: 'invite-1',
      tokenHash: 'token-hash',
      status: 'PENDING',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
      clientId: 'client-1',
      createdByStaff: 'staff-1',
      client: { id: 'client-1', kind: 'JURPERS' },
    });
    m.revalidateInvite
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    m.commitPreparedBytes.mockResolvedValue({
      targetBucket: 'taxtronik-gwg',
      targetKey: 'tenant-1/evidence.bin',
      storageVersionId: 'version-123',
      sha256: Buffer.alloc(32),
      sizeBytes: 1n,
      immutable: true,
      retentionUntil: new Date('2099-01-01T00:00:00.000Z'),
      detectedMime: 'application/pdf',
    });

    const result = await uploadIdImageAction({
      token: 'valid-looking-raw-token',
      fileName: 'ausweis.pdf',
      mimeType: 'application/pdf',
      base64: 'YQ==',
      kind: 'ID_DOCUMENT',
    });

    expect(result.ok).toBe(false);
    expect(m.createPendingDocumentWithVersion).toHaveBeenCalledOnce();
    expect(m.finalizePendingDocumentVersion).not.toHaveBeenCalled();
    expect(m.createPendingDocumentWithVersion.mock.invocationCallOrder[0]).toBeLessThan(
      m.commitPreparedBytes.mock.invocationCallOrder[0]!,
    );
    expect(m.deleteObjectVersion).toHaveBeenCalledWith(
      'taxtronik-gwg',
      'tenant-1/evidence.bin',
      'version-123',
      { bypassGovernanceRetention: true },
    );
  });

  it('löscht bei einem DB-Fehler exakt die bereits geschriebene GwG-Objektversion', async () => {
    m.findFirst.mockResolvedValueOnce({
      id: 'invite-1',
      tokenHash: 'token-hash',
      status: 'PENDING',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
      clientId: 'client-1',
      createdByStaff: 'staff-1',
      client: { id: 'client-1', kind: 'JURPERS' },
    });
    m.revalidateInvite.mockResolvedValue(true);
    m.commitPreparedBytes.mockResolvedValue({
      targetBucket: 'taxtronik-gwg',
      targetKey: 'tenant-1/evidence.bin',
      storageVersionId: 'version-456',
      sha256: Buffer.alloc(32),
      sizeBytes: 1n,
      immutable: true,
      retentionUntil: new Date('2099-01-01T00:00:00.000Z'),
      detectedMime: 'application/pdf',
    });
    m.finalizePendingDocumentVersion.mockRejectedValueOnce(new Error('DB unavailable'));

    const result = await uploadIdImageAction({
      token: 'valid-looking-raw-token',
      fileName: 'ausweis.pdf',
      mimeType: 'application/pdf',
      base64: 'YQ==',
      kind: 'ID_DOCUMENT',
    });

    expect(result.ok).toBe(false);
    expect(m.deleteObjectVersion).toHaveBeenCalledWith(
      'taxtronik-gwg',
      'tenant-1/evidence.bin',
      'version-456',
      { bypassGovernanceRetention: true },
    );
  });

  it('rekonstruiert Erfolg nach verlorenem COMMIT-ACK ohne den referenzierten GwG-Beleg zu löschen', async () => {
    m.findFirst.mockResolvedValueOnce({
      id: 'invite-1',
      tokenHash: 'token-hash',
      status: 'PENDING',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
      clientId: 'client-1',
      createdByStaff: 'staff-1',
      client: { id: 'client-1', kind: 'JURPERS' },
    });
    m.revalidateInvite.mockResolvedValue(true);
    m.commitPreparedBytes.mockResolvedValue({
      targetBucket: 'taxtronik-gwg',
      targetKey: 'tenant-1/evidence.bin',
      storageVersionId: 'version-committed',
      sha256: Buffer.alloc(32),
      sizeBytes: 1n,
      immutable: true,
      retentionUntil: new Date('2099-01-01T00:00:00.000Z'),
      detectedMime: 'application/pdf',
    });
    m.findVersion.mockResolvedValue({
      documentId: 'document-pending',
      storageBucket: 'taxtronik-gwg',
      storageKey: 'tenant-1/evidence.bin',
      storageVersionId: 'version-committed',
      scanStatus: 'CLEAN',
    });
    let systemContextCall = 0;
    m.withSystemContext.mockImplementation(
      async (_tenantId: string, fn: (tx: Record<string, unknown>) => unknown) => {
        systemContextCall += 1;
        const result = await fn({
          $executeRaw: vi.fn(),
          document: { deleteMany: m.deleteDocument },
          documentVersion: { findUnique: m.findVersion },
        });
        if (systemContextCall === 3) {
          throw new Error('COMMIT acknowledgement lost');
        }
        return result;
      },
    );

    await expect(
      uploadIdImageAction({
        token: 'valid-looking-raw-token',
        fileName: 'ausweis.pdf',
        mimeType: 'application/pdf',
        base64: 'YQ==',
        kind: 'ID_DOCUMENT',
      }),
    ).resolves.toEqual({ ok: true, documentId: 'document-pending' });
    expect(m.findVersion).toHaveBeenCalledOnce();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
    expect(m.deleteDocument).not.toHaveBeenCalled();
  });

  it('behält das PENDING-Journal bei einem Fehler nach PUT aber vor dem Storage-Ergebnis', async () => {
    m.findFirst.mockResolvedValueOnce({
      id: 'invite-1',
      tokenHash: 'token-hash',
      status: 'PENDING',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
      clientId: 'client-1',
      createdByStaff: 'staff-1',
      client: { id: 'client-1', kind: 'JURPERS' },
    });
    m.revalidateInvite.mockResolvedValue(true);
    m.commitPreparedBytes.mockRejectedValue(
      new Error('object persisted, but version inventory response failed'),
    );

    const result = await uploadIdImageAction({
      token: 'valid-looking-raw-token',
      fileName: 'ausweis.pdf',
      mimeType: 'application/pdf',
      base64: 'YQ==',
      kind: 'ID_DOCUMENT',
    });

    expect(result.ok).toBe(false);
    expect(m.createPendingDocumentWithVersion).toHaveBeenCalledOnce();
    expect(m.findVersion).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
    expect(m.deleteDocument).not.toHaveBeenCalled();
  });

  it('verwirft einen noch ungebundenen Invite-Upload physisch und aus der Datenbank', async () => {
    const documentId = '00000000-0000-4000-8000-000000000001';
    m.findFirst.mockResolvedValueOnce({
      id: 'invite-1',
      tokenHash: 'token-hash',
      status: 'STARTED',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
      clientId: 'client-1',
      createdByStaff: 'staff-1',
      uploadedDocumentIds: [documentId],
      client: { id: 'client-1', kind: 'JURPERS' },
    });
    m.revalidateInvite.mockResolvedValue(true);
    m.queryRaw
      .mockResolvedValueOnce([
        {
          title: 'ausweis.pdf',
          storageBucket: 'taxtronik-gwg',
          storageKey: 'tenant-1/evidence.bin',
          storageVersionId: 'version-discard',
        },
      ])
      .mockResolvedValueOnce([{ discarded: 1 }]);

    await expect(
      discardOnboardingUploadAction({ token: 'valid-looking-raw-token', documentId }),
    ).resolves.toEqual({ ok: true });
    expect(m.deleteObjectVersion).toHaveBeenCalledWith(
      'taxtronik-gwg',
      'tenant-1/evidence.bin',
      'version-discard',
      { bypassGovernanceRetention: true },
    );
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'gwg.onboarding.upload.discard',
        resourceId: documentId,
      }),
    );
  });
});
