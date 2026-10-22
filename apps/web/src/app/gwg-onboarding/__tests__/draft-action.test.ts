// Fachkatalog: GWG-SELF-ONBOARDING-001
// Speichern des Zwischenstands über den Einladungslink: nur für offene,
// aktuelle Einladungen, unter derselben Sperre wie Upload und Einreichung.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  inviteFindFirst: vi.fn(),
  withSystemContext: vi.fn(),
  revalidate: vi.fn(),
  draftFindUnique: vi.fn(),
  draftCreateMany: vi.fn(),
  draftUpdateMany: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@taxtronik/storage', () => ({
  prepareBytesCommitWithTier: vi.fn(),
  commitPreparedBytes: vi.fn(),
  deleteObjectVersion: vi.fn(),
  fetchVerifiedObjectBytes: vi.fn(),
  StoredObjectError: class StoredObjectError extends Error {},
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: m.withSystemContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/documents/upload-helpers', () => ({
  createPendingDocumentWithVersion: vi.fn(),
  finalizePendingDocumentVersion: vi.fn(),
}));
vi.mock('@/server/auth/rbac', async () => ({
  ...(await import('@/server/actions/to-action-error')),
}));
vi.mock('@/server/gwg-onboarding/service', () => ({
  expireOpenInviteIfDue: vi.fn(),
  GENERIC_TOKEN_ERROR: 'Einladung ungültig oder nicht mehr verfügbar.',
  hashInviteToken: () => 'token-hash',
  prismaOwner: { gwgOnboardingInvite: { findFirst: m.inviteFindFirst } },
}));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ ok: true })),
  checkIpOrGlobalLimit: vi.fn(async () => ({ ok: true })),
  getClientIp: () => '192.0.2.1',
}));
vi.mock('@/server/logger', () => ({ log: { error: m.logError, warn: vi.fn() } }));
vi.mock('@/server/notifications/service', () => ({ notifyMany: vi.fn() }));
vi.mock('@/server/privacy/consent-catalog', () => ({
  ConsentDisplayChangedError: class ConsentDisplayChangedError extends Error {},
  RequiredConsentOptionsError: class RequiredConsentOptionsError extends Error {},
  resolveConsentSelectionsTx: vi.fn(),
}));
vi.mock('@/server/privacy/catalog-lock', () => ({ lockConsentCatalogTx: vi.fn() }));
vi.mock('@/server/privacy/consent-display', () => ({
  CONSENT_DISPLAY_CHANGED_MESSAGE: 'Anzeige geändert.',
}));
vi.mock('@/server/privacy/service', () => ({ renderNoticeForTenantTx: vi.fn() }));
vi.mock('@/server/gwg/reverification', () => ({ startFreshGwgReviewTx: vi.fn() }));
vi.mock('@/server/gwg/evidence-documents', () => ({
  lockCleanGwgEvidenceDocumentsTx: vi.fn(),
}));
vi.mock('@/server/gwg-onboarding/invite-lifecycle', () => ({
  claimCurrentGwgInviteSubmitTx: vi.fn(),
  revalidateOpenGwgInviteRevisionTx: m.revalidate,
}));
vi.mock('@/server/gwg-onboarding/bound-review', () => ({
  canStartUnboundGwgInviteTx: vi.fn(),
  resolveBoundGwgInviteDraftTx: vi.fn(),
}));
vi.mock('@/server/gwg-onboarding/document-folders', () => ({
  ensureGwgRootFolderTx: vi.fn(),
  ensureGwgPersonFolderTx: vi.fn(),
}));

import { saveOnboardingDraftAction } from '../actions';

const INVITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYLOAD = {
  version: 1 as const,
  step: 0,
  reached: 0,
  master: {
    companyName: 'Muster GmbH',
    street: 'Hauptstr. 1',
    postalCode: '36304',
    city: 'Alsfeld',
    countryIso: 'DE',
  },
  owners: [],
  representatives: [],
  extraDocuments: [],
  noRegisterEntry: null,
};

const tx = {
  gwgOnboardingDraft: {
    findUnique: m.draftFindUnique,
    createMany: m.draftCreateMany,
    updateMany: m.draftUpdateMany,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.inviteFindFirst.mockResolvedValue({
    id: INVITE_ID,
    tenantId: 'tenant-1',
    clientId: 'client-1',
    status: 'STARTED',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  m.withSystemContext.mockImplementation(
    async (_tenantId: string, run: (client: typeof tx) => unknown) => run(tx),
  );
  m.revalidate.mockResolvedValue(true);
  m.draftCreateMany.mockResolvedValue({ count: 1 });
  m.draftUpdateMany.mockResolvedValue({ count: 1 });
});

describe('saveOnboardingDraftAction', () => {
  it('speichert unter der Einladungssperre auf der übergebenen Revision', async () => {
    const result = await saveOnboardingDraftAction({
      token: 'token-1234567890',
      revision: 2,
      payload: PAYLOAD,
    });
    expect(result).toMatchObject({ ok: true, revision: 3 });
    expect(m.revalidate).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        inviteId: INVITE_ID,
        tenantId: 'tenant-1',
        clientId: 'client-1',
        tokenHash: 'token-hash',
      }),
    );
    expect(m.revalidate.mock.invocationCallOrder[0]).toBeLessThan(
      m.draftUpdateMany.mock.invocationCallOrder[0]!,
    );
    expect(m.draftUpdateMany).toHaveBeenCalledWith({
      where: { inviteId: INVITE_ID, revision: 2 },
      data: expect.objectContaining({ payload: PAYLOAD }),
    });
  });

  it('speichert nichts mehr, sobald die Einladung nicht mehr offen ist', async () => {
    m.revalidate.mockResolvedValue(false);
    expect(
      await saveOnboardingDraftAction({ token: 'token-1234567890', revision: 0, payload: PAYLOAD }),
    ).toEqual({ ok: false, error: 'Einladung ungültig oder nicht mehr verfügbar.' });
    expect(m.draftCreateMany).not.toHaveBeenCalled();
  });

  it('gibt für eingereichte Einladungen dieselbe anonyme Meldung', async () => {
    m.inviteFindFirst.mockResolvedValue({
      id: INVITE_ID,
      tenantId: 'tenant-1',
      clientId: 'client-1',
      status: 'SUBMITTED',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(
      await saveOnboardingDraftAction({ token: 'token-1234567890', revision: 1, payload: PAYLOAD }),
    ).toEqual({ ok: false, error: 'Einladung ungültig oder nicht mehr verfügbar.' });
    expect(m.withSystemContext).not.toHaveBeenCalled();
  });

  it('lehnt einen ungültigen Formularstand ohne Datenbankzugriff ab', async () => {
    expect(
      await saveOnboardingDraftAction({
        token: 'token-1234567890',
        revision: 1,
        payload: { ...PAYLOAD, step: 9 },
      }),
    ).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { 'payload.step': [expect.any(String)] },
    });
    expect(m.inviteFindFirst).not.toHaveBeenCalled();
  });
});
