import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findInvite: vi.fn(),
  expireInvite: vi.fn(),
  currentInvite: vi.fn(),
  withSystemContext: vi.fn(),
  revalidateInvite: vi.fn(),
  ipLimit: vi.fn(),
  tokenLimit: vi.fn(),
  loadSource: vi.fn(),
  readBytes: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@taxtronik/storage', () => ({
  prepareBytesCommitWithTier: vi.fn(),
  commitPreparedBytes: vi.fn(),
  deleteObjectVersion: vi.fn(),
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: m.withSystemContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.audit } }));
vi.mock('@/server/documents/upload-helpers', () => ({
  createPendingDocumentWithVersion: vi.fn(),
  finalizePendingDocumentVersion: vi.fn(),
}));
vi.mock('@/server/gwg-onboarding/invite-lifecycle', () => ({
  revalidateOpenGwgInviteRevisionTx: m.revalidateInvite,
  claimCurrentGwgInviteSubmitTx: vi.fn(),
}));
vi.mock('@/server/gwg-onboarding/document-folders', () => ({
  ensureGwgRootFolderTx: vi.fn(),
  ensureGwgPersonFolderTx: vi.fn(),
}));
vi.mock('@/server/auth/rbac', () => ({ toActionError: vi.fn() }));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { gwgOnboardingInvite: { findFirst: m.findInvite, updateMany: m.expireInvite } },
}));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: m.tokenLimit,
  checkIpOrGlobalLimit: m.ipLimit,
  getClientIp: vi.fn(() => '192.0.2.1'),
}));
vi.mock('@/server/gwg/identity-source', () => ({
  loadIdentitySourceTx: m.loadSource,
  readIdentitySourceBytes: m.readBytes,
}));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/notifications/service', () => ({ notifyMany: vi.fn() }));

import { loadOnboardingIdentitySourceAction } from '../actions';
import { GENERIC_TOKEN_ERROR, hashInviteToken } from '@/server/gwg-onboarding/service';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'valid-secret-invitation-token';
const input = { token: TOKEN, documentId: DOCUMENT_ID };
const tx = { gwgOnboardingInvite: { findFirst: m.currentInvite } };
const unavailable = {
  ok: false,
  error:
    'Die Datei ist nicht verfügbar. Bitte manuell weiterarbeiten oder die Einladung neu laden.',
};
function invite() {
  return {
    id: 'invite-1',
    tenantId: 'tenant-from-token',
    clientId: 'client-from-token',
    status: 'STARTED',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    uploadedDocumentIds: [DOCUMENT_ID],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.ipLimit.mockResolvedValue({ ok: true });
  m.tokenLimit.mockResolvedValue({ ok: true });
  m.findInvite.mockResolvedValue(invite());
  m.expireInvite.mockResolvedValue({ count: 1 });
  m.withSystemContext.mockImplementation(
    async (_tenant: string, work: (value: typeof tx) => unknown) => work(tx),
  );
  m.revalidateInvite.mockResolvedValue(true);
  m.currentInvite.mockResolvedValue({
    uploadedDocumentIds: [DOCUMENT_ID],
    gwgCheck: { idDocuments: [] },
  });
  m.loadSource.mockResolvedValue({
    documentId: DOCUMENT_ID,
    mimeType: 'image/png',
    version: { id: 'current-version' },
  });
  m.readBytes.mockResolvedValue(Buffer.from('original'));
});

describe('GWG-SELF-ONBOARDING-001 / GWG-IDENTIFICATION-EVIDENCE-001: token-bound source access', () => {
  it('revalidates before reading the current allowed IDs and scopes the source to the token tenant/client', async () => {
    expect(await loadOnboardingIdentitySourceAction(input)).toEqual({
      ok: true,
      base64: Buffer.from('original').toString('base64'),
      mimeType: 'image/png',
      versionId: 'current-version',
    });
    expect(m.findInvite).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashInviteToken(TOKEN) } }),
    );
    expect(m.withSystemContext).toHaveBeenCalledWith('tenant-from-token', expect.any(Function));
    expect(m.revalidateInvite).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-from-token',
      clientId: 'client-from-token',
      inviteId: 'invite-1',
      tokenHash: hashInviteToken(TOKEN),
      now: expect.any(Date),
    });
    expect(m.currentInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'invite-1', tenantId: 'tenant-from-token', tokenHash: hashInviteToken(TOKEN) },
      }),
    );
    expect(m.revalidateInvite.mock.invocationCallOrder[0]).toBeLessThan(
      m.currentInvite.mock.invocationCallOrder[0]!,
    );
    expect(m.currentInvite.mock.invocationCallOrder[0]).toBeLessThan(
      m.loadSource.mock.invocationCallOrder[0]!,
    );
    expect(m.loadSource).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-from-token',
      clientId: 'client-from-token',
      documentId: DOCUMENT_ID,
    });
    expect(m.audit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'gwg.identity.source.view',
        actorType: 'CLIENT_CONTACT',
        actorId: null,
        after: {
          clientId: 'client-from-token',
          inviteId: 'invite-1',
          versionId: 'current-version',
        },
      }),
    );
  });
  it('allows a currently bound original from the check even when it is not a new invite upload', async () => {
    m.currentInvite.mockResolvedValue({
      uploadedDocumentIds: [],
      gwgCheck: { idDocuments: [{ documentId: DOCUMENT_ID }, { documentId: null }] },
    });
    expect(await loadOnboardingIdentitySourceAction(input)).toMatchObject({ ok: true });
  });
  it.each(['CANCELLED', 'EXPIRED', 'SUBMITTED'])(
    'rejects a closed %s invite before entering the tenant transaction',
    async (status) => {
      m.findInvite.mockResolvedValue({ ...invite(), status });
      expect(await loadOnboardingIdentitySourceAction(input)).toEqual(unavailable);
      expect(m.withSystemContext).not.toHaveBeenCalled();
      expect(m.readBytes).not.toHaveBeenCalled();
    },
  );
  it('rejects a due invite with a status-bound expiry CAS', async () => {
    m.findInvite.mockResolvedValue({ ...invite(), expiresAt: new Date('2000-01-01') });
    expect(await loadOnboardingIdentitySourceAction(input)).toEqual(unavailable);
    expect(m.expireInvite).toHaveBeenCalledWith({
      where: {
        id: 'invite-1',
        status: { in: ['PENDING', 'STARTED'] },
        expiresAt: { lte: expect.any(Date) },
      },
      data: { status: 'EXPIRED' },
    });
    expect(m.readBytes).not.toHaveBeenCalled();
  });
  it('rejects a canceled, replaced or stale revision detected under the lifecycle lock', async () => {
    m.revalidateInvite.mockResolvedValue(false);
    expect(await loadOnboardingIdentitySourceAction(input)).toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });
    expect(m.currentInvite).not.toHaveBeenCalled();
    expect(m.loadSource).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { uploadedDocumentIds: [], gwgCheck: null },
    { uploadedDocumentIds: [42], gwgCheck: { idDocuments: [{ documentId: null }] } },
  ])(
    'rejects a foreign/unbound source using the current relation, not the earlier invite snapshot: %o',
    async (current) => {
      m.currentInvite.mockResolvedValue(current);
      expect(await loadOnboardingIdentitySourceAction(input)).toEqual({
        ok: false,
        error: GENERIC_TOKEN_ERROR,
      });
      expect(m.loadSource).not.toHaveBeenCalled();
      expect(m.readBytes).not.toHaveBeenCalled();
    },
  );
  it('does not expose unavailable or unclean document contents', async () => {
    m.loadSource.mockResolvedValue(null);
    expect(await loadOnboardingIdentitySourceAction(input)).toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });
    expect(m.readBytes).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it.each(['lookup', 'bytes'])(
    'hides raw %s errors and never audits a failed source response',
    async (failure) => {
      if (failure === 'lookup')
        m.findInvite.mockRejectedValue(new Error('database password / internal hostname'));
      else m.readBytes.mockRejectedValue(new Error('object hash mismatch / secret storage key'));
      expect(await loadOnboardingIdentitySourceAction(input)).toEqual(unavailable);
      expect(m.audit).not.toHaveBeenCalled();
    },
  );
  it.each(['ip', 'token'])(
    'rate-limits %s requests before token lookup and storage access',
    async (limiter) => {
      (limiter === 'ip' ? m.ipLimit : m.tokenLimit).mockResolvedValue({ ok: false });
      expect(await loadOnboardingIdentitySourceAction(input)).toEqual({
        ok: false,
        error: 'Zu viele Abrufe. Bitte später erneut versuchen.',
      });
      expect(m.findInvite).not.toHaveBeenCalled();
      expect(m.readBytes).not.toHaveBeenCalled();
      if (limiter === 'ip') expect(m.tokenLimit).not.toHaveBeenCalled();
      else
        expect(m.tokenLimit).toHaveBeenCalledWith(
          `gwg-source-token:${hashInviteToken(TOKEN).slice(0, 16)}`,
          { max: 60, windowSec: 600 },
        );
    },
  );
  it('rejects malformed IDs/tokens before any rate or source IO', async () => {
    expect(
      await loadOnboardingIdentitySourceAction({ token: 'short', documentId: DOCUMENT_ID }),
    ).toEqual({ ok: false, error: GENERIC_TOKEN_ERROR });
    expect(
      await loadOnboardingIdentitySourceAction({ ...input, documentId: 'other-client/document' }),
    ).toEqual({ ok: false, error: GENERIC_TOKEN_ERROR });
    expect(m.ipLimit).not.toHaveBeenCalled();
    expect(m.findInvite).not.toHaveBeenCalled();
  });
});
