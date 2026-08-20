// =============================================================================
// Unit-Tests: PoA-Signatur-Flow — OTP-Fehlversuchszähler (poa/actions.ts).
//
// Audit 2026-06 Befund 2: Der pro-OTP-Zähler (signingOtpAttempts, max 5) wird
// beim Re-Issue bewusst auf 0 gesetzt (UX) — mit dem Issue-Cap von 10 ergab
// das ~50 Gesamtversuche pro Signatur-Token. Seit iter84 zählt
// signingOtpAttemptsTotal über den GANZEN Token-Lebenszyklus (Cap 15) und
// überlebt Re-Issues; Reset nur beim Versand eines neuen Signatur-Tokens.
//
// Prisma/Mail/Rate-Limit/Headers komplett gemockt (Muster magic-link.test.ts).
// Abgedeckt:
//   - signPoaAction: falsches OTP inkrementiert BEIDE Zähler; Invalidierung
//     bei pro-OTP-Cap (5) UND bei Lebenszyklus-Cap (15, auch wenn der
//     pro-OTP-Zähler frisch ist); Erfolg setzt beide zurück
//   - requestSigningOtpAction: Re-Issue resettet NUR den pro-OTP-Zähler,
//     niemals den Total-Zähler
//   - sendForSignatureAction: neuer Signatur-Token = neuer Lebenszyklus →
//     beide Zähler auf 0
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    sendTemplateMail: vi.fn(),
    checkRateLimit: vi.fn(),
    checkIpOrGlobalLimit: vi.fn(),
    getClientIp: vi.fn(),
    notify: vi.fn(),
    withTenantContext: vi.fn(),
    evidenceRecord: vi.fn(),
    staffActionGuard: vi.fn(),
    withStaff: vi.fn(),
    isStaffAdmin: vi.fn(),
    assertClientAccessTx: vi.fn(),
    readModules: vi.fn(),
    prepareBytesCommitWithTier: vi.fn(),
    commitPreparedBytes: vi.fn(),
    recoverPreparedBytesCommit: vi.fn(),
    redirect: vi.fn(),
    revalidatePath: vi.fn(),
    headers: vi.fn(),
    prismaOwner: {
      powerOfAttorney: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      documentVersion: { findFirst: vi.fn() },
      tenant: { findUnique: vi.fn() },
    },
  };
});

vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('next/headers', () => ({ headers: m.headers }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
// storage muss gemockt werden: das echte Paket lädt seine injizierte
// @taxtronik/config-Kopie (anderer Modulpfad), die der Config-Mock unten nicht
// abdeckt — deren ENV-Validierung würfe ohne vollständige ENV beim Import.
vi.mock('@taxtronik/storage', () => ({
  prepareBytesCommitWithTier: m.prepareBytesCommitWithTier,
  commitPreparedBytes: m.commitPreparedBytes,
  recoverPreparedBytesCommit: m.recoverPreparedBytesCommit,
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
}));
vi.mock('@taxtronik/config', () => ({
  portalBaseUrl: 'https://portal.example.de',
  env: {
    S3_ENDPOINT: 'http://seaweedfs:8333',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'test-access-key',
    S3_SECRET_KEY: 'test-secret-key',
    S3_BUCKET_GOBD: 'gobd',
    S3_BUCKET_GWG: 'gwg',
    S3_BUCKET_STAFF_PRIVATE: 'staff-private',
    S3_BUCKET_GENERAL: 'general',
  },
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: m.sendTemplateMail }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: m.prismaOwner }));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: m.checkRateLimit,
  checkIpOrGlobalLimit: m.checkIpOrGlobalLimit,
  getClientIp: m.getClientIp,
}));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: m.isStaffAdmin,
  assertClientAccessTx: m.assertClientAccessTx,
  toActionError: (e: unknown) => ({
    ok: false,
    error: e instanceof Error ? e.message : 'Fehler.',
  }),
}));
vi.mock('@/server/actions/staff-action', async () => {
  const { parseFormData } = await import('@/server/actions/form-data');
  return {
    ActionError: m.ActionError,
    staffActionGuard: m.staffActionGuard,
    withStaff: m.withStaff,
    parseFormData,
  };
});
vi.mock('@/server/settings/modules', () => ({ readModules: m.readModules }));
vi.mock('@/server/notifications/service', () => ({ notify: m.notify }));

import { createPoaAction, revokePoaAction, sendForSignatureAction } from '../actions';
import { loadPoaForSigning, requestSigningOtpAction, signPoaAction } from '../sign-actions';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const RAW_TOKEN = 'poa-signing-token-0123456789abcdef';
const OTP = '123456';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const UPLOAD_INTENT_ID = '7c5ab09d-f61c-431a-8fe5-dbd9ca1ea7f5';
const PREPARED_PDF = {
  tier: 'GOBD' as const,
  tenantId: 'tenant-1',
  targetBucket: 'gobd',
  targetKey: 'tenants/tenant-1/gobd/2026/07/poa.bin',
  sha256: Buffer.alloc(32, 3),
  sizeBytes: 9n,
  immutable: true,
  retentionUntil: new Date('2033-01-01T00:00:00.000Z'),
  detectedMime: 'application/pdf',
};
const COMMITTED_PDF = { ...PREPARED_PDF, storageVersionId: 'storage-version-1' };

function validPdfPoaFormData(): FormData {
  const fd = new FormData();
  fd.set('clientId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
  fd.set('uploadIntentId', UPLOAD_INTENT_ID);
  fd.set('signerEmail', 'signer@example.de');
  fd.set('signerName', 'Sina Signer');
  fd.set('subject', 'Vollmacht');
  fd.set('validFrom', '2026-08-10');
  fd.set(
    'poaPdf',
    new File([Buffer.from('%PDF-1.7\n')], 'vollmacht.pdf', { type: 'application/pdf' }),
  );
  return fd;
}

function validMarkdownPoaFormData(returnContext?: string): FormData {
  const fd = new FormData();
  fd.set('clientId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
  fd.set('signerEmail', 'signer@example.de');
  fd.set('signerName', 'Sina Signer');
  fd.set('subject', 'Vollmacht');
  fd.set('scope', 'Vertretung');
  fd.set('validFrom', '2026-08-10');
  if (returnContext) fd.set('returnContext', returnContext);
  return fd;
}

function snapshotFields(validUntil: string | null = '2099-12-31') {
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    subject: 'Vollmacht Finanzamt',
    signerName: 'Sina Signer',
    signerEmail: 'signer@example.de',
    validFrom: '2026-01-01',
    validUntil,
    scope: 'Vertretung gegenüber dem Finanzamt',
    document: null,
  });
  return {
    signingContentSnapshot: snapshot,
    signingContentSha256: createHash('sha256').update(snapshot).digest(),
    signingDocumentVersionId: null,
  };
}

const noSnapshotFields = {
  signingContentSnapshot: null,
  signingContentSha256: null,
  signingDocumentVersionId: null,
} as const;

function poaRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'poa-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    signerContactId: null,
    signerEmail: 'signer@example.de',
    signerName: 'Sina Signer',
    subject: 'Vollmacht Finanzamt',
    scope: 'Vertretung gegenüber dem Finanzamt',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: new Date('2099-12-31T00:00:00.000Z'),
    documentId: null,
    status: 'SENT',
    signingTokenHash: sha256(RAW_TOKEN),
    signingTokenExpiresAt: FUTURE,
    signingOtpHash: sha256(OTP),
    signingOtpExpiresAt: FUTURE,
    signingOtpAttempts: 0,
    signingOtpAttemptsTotal: 0,
    createdByStaff: 'staff-1',
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    ...snapshotFields(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.checkRateLimit.mockResolvedValue({ ok: true });
  m.checkIpOrGlobalLimit.mockResolvedValue({ ok: true });
  m.getClientIp.mockReturnValue('198.51.100.7');
  m.headers.mockResolvedValue(new Headers({ 'user-agent': 'vitest' }));
  m.prismaOwner.powerOfAttorney.findFirst.mockResolvedValue(poaRecord());
  m.prismaOwner.powerOfAttorney.update.mockResolvedValue({
    signingOtpAttempts: 1,
    signingOtpAttemptsTotal: 1,
  });
  m.prismaOwner.powerOfAttorney.updateMany.mockResolvedValue({ count: 1 });
  m.prismaOwner.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', name: 'Kanzlei X' });
  m.sendTemplateMail.mockResolvedValue({ ok: true, sentViaTemplate: true });
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn(m.prismaOwner),
  );
  m.evidenceRecord.mockResolvedValue({});
  m.notify.mockResolvedValue(undefined);
  m.isStaffAdmin.mockReturnValue(true);
  m.readModules.mockResolvedValue({ poaMode: 'MARKDOWN_OTP' });
  m.prepareBytesCommitWithTier.mockResolvedValue(PREPARED_PDF);
  m.commitPreparedBytes.mockResolvedValue(COMMITTED_PDF);
  m.recoverPreparedBytesCommit.mockResolvedValue(null);
});

// -----------------------------------------------------------------------------
// signPoaAction — Fehlversuchszähler
// -----------------------------------------------------------------------------

describe('signPoaAction — falsches OTP', () => {
  it('inkrementiert BEIDE Zähler (pro-OTP + Lebenszyklus)', async () => {
    const res = await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999', consentAccepted: true });
    expect(res.ok).toBe(false);
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenCalledTimes(1);
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenCalledWith({
      where: { id: 'poa-1' },
      data: {
        signingOtpAttempts: { increment: 1 },
        signingOtpAttemptsTotal: { increment: 1 },
      },
      select: { signingOtpAttempts: true, signingOtpAttemptsTotal: true },
    });
  });

  it('unter beiden Caps → KEINE Token-Invalidierung', async () => {
    m.prismaOwner.powerOfAttorney.update.mockResolvedValueOnce({
      signingOtpAttempts: 4,
      signingOtpAttemptsTotal: 14,
    });
    await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999', consentAccepted: true });
    // Nur der Increment-Call — kein zweiter Update zur Invalidierung.
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenCalledTimes(1);
  });

  it('pro-OTP-Cap (5) erreicht → Token + OTP entwertet, Zähler zurückgesetzt', async () => {
    m.prismaOwner.powerOfAttorney.update.mockResolvedValueOnce({
      signingOtpAttempts: 5,
      signingOtpAttemptsTotal: 5,
    });
    await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999', consentAccepted: true });
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenCalledTimes(2);
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenLastCalledWith({
      where: { id: 'poa-1' },
      data: {
        signingTokenHash: null,
        signingOtpHash: null,
        signingOtpAttempts: 0,
        signingOtpAttemptsTotal: 0,
      },
    });
  });

  it('Lebenszyklus-Cap (15) erreicht → Invalidierung AUCH bei frischem pro-OTP-Zähler', async () => {
    // Kern von Befund 2: 14 Fehlversuche über frühere OTP-Zyklen, frisches
    // OTP (Re-Issue hat signingOtpAttempts resettet) — der 15. Fehlversuch
    // beendet den Lebenszyklus, obwohl pro-OTP erst 1/5 erreicht ist.
    m.prismaOwner.powerOfAttorney.update.mockResolvedValueOnce({
      signingOtpAttempts: 1,
      signingOtpAttemptsTotal: 15,
    });
    await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999', consentAccepted: true });
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenCalledTimes(2);
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenLastCalledWith({
      where: { id: 'poa-1' },
      data: {
        signingTokenHash: null,
        signingOtpHash: null,
        signingOtpAttempts: 0,
        signingOtpAttemptsTotal: 0,
      },
    });
  });
});

describe('signPoaAction — korrektes OTP', () => {
  it('signiert atomar und setzt beide Zähler zurück', async () => {
    const res = await signPoaAction({ rawToken: RAW_TOKEN, otp: OTP, consentAccepted: true });
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.powerOfAttorney.updateMany).toHaveBeenCalledWith({
      where: { id: 'poa-1', status: 'SENT', signingTokenHash: sha256(RAW_TOKEN) },
      data: expect.objectContaining({
        status: 'SIGNED',
        signingTokenHash: null,
        signingOtpHash: null,
        signingOtpAttempts: 0,
        signingOtpAttemptsTotal: 0,
      }),
    });
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord.mock.calls[0]![0]).toBe(m.prismaOwner);
    expect(m.evidenceRecord.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        action: 'poa.sign',
        after: expect.objectContaining({ explicitContentConsent: true }),
      }),
    );
  });
});

describe('explizite Inhaltsbestätigung', () => {
  it('signiert serverseitig nicht ohne ausdrückliche Bestätigung', async () => {
    const res = await signPoaAction({ rawToken: RAW_TOKEN, otp: OTP, consentAccepted: false });
    expect(res).toEqual({
      ok: false,
      error: 'Bitte bestätigen Sie den Vollmachtsinhalt ausdrücklich.',
    });
    expect(m.prismaOwner.powerOfAttorney.findFirst).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('versendet auch den Code nicht ohne ausdrückliche Bestätigung', async () => {
    const res = await requestSigningOtpAction({
      rawToken: RAW_TOKEN,
      consentAccepted: false,
    });
    expect(res.ok).toBe(false);
    expect(m.sendTemplateMail).not.toHaveBeenCalled();
  });
});

describe('Ablauf-Gate', () => {
  it('signiert einen abgelaufenen Versand-Snapshot nicht', async () => {
    m.prismaOwner.powerOfAttorney.findFirst.mockResolvedValue(
      poaRecord({
        validUntil: new Date('2020-01-01T00:00:00.000Z'),
        ...snapshotFields('2020-01-01'),
      }),
    );
    const res = await signPoaAction({ rawToken: RAW_TOKEN, otp: OTP, consentAccepted: true });
    expect(res.ok).toBe(false);
    expect(m.prismaOwner.powerOfAttorney.updateMany).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('loadPoaForSigning — gebundene Anzeige', () => {
  it('zeigt Snapshot-Werte statt nachträglich veränderter Live-Felder', async () => {
    m.prismaOwner.powerOfAttorney.findFirst.mockResolvedValue(
      poaRecord({
        subject: 'Nachträglich geänderter Betreff',
        scope: 'Nachträglich geänderter Umfang',
        signerName: 'Andere Person',
      }),
    );

    const result = await loadPoaForSigning(RAW_TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unerwarteter Fehler');
    expect(result.poa).toEqual(
      expect.objectContaining({
        subject: 'Vollmacht Finanzamt',
        scope: 'Vertretung gegenüber dem Finanzamt',
        signerName: 'Sina Signer',
      }),
    );
  });

  it('verwirft einen manipulierten Snapshot', async () => {
    const fields = snapshotFields();
    m.prismaOwner.powerOfAttorney.findFirst.mockResolvedValue(
      poaRecord({
        ...fields,
        signingContentSnapshot: fields.signingContentSnapshot.replace('Finanzamt', 'Finanzgericht'),
      }),
    );

    const result = await loadPoaForSigning(RAW_TOKEN);
    expect(result.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// requestSigningOtpAction — Re-Issue
// -----------------------------------------------------------------------------

describe('requestSigningOtpAction — Re-Issue', () => {
  it('resettet NUR den pro-OTP-Zähler, niemals signingOtpAttemptsTotal', async () => {
    const res = await requestSigningOtpAction({ rawToken: RAW_TOKEN, consentAccepted: true });
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenCalledTimes(1);
    const { data } = m.prismaOwner.powerOfAttorney.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.signingOtpAttempts).toBe(0);
    // Der Lebenszyklus-Zähler überlebt das Re-Issue — sonst wäre der
    // 15er-Cap per „neuen Code anfordern" umgehbar (zurück zu ~50 Versuchen).
    expect(data).not.toHaveProperty('signingOtpAttemptsTotal');
    expect(m.sendTemplateMail).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// sendForSignatureAction — neuer Lebenszyklus
// -----------------------------------------------------------------------------

describe('sendForSignatureAction', () => {
  it('neuer Signatur-Token setzt BEIDE Zähler auf 0 (einziger Total-Reset)', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const tx = {
      powerOfAttorney: {
        findUnique: vi.fn().mockResolvedValue(poaRecord({ status: 'DRAFT', ...noSnapshotFields })),
        // Neuer Flow: atomarer Claim via updateMany + Re-Fetch.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(poaRecord({ status: 'SENT' })),
      },
      documentVersion: { findFirst: vi.fn() },
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', name: 'Kanzlei X' }) },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    );

    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('expectedUpdatedAt', '2026-08-20T10:00:00.000Z');
    const res = await sendForSignatureAction(fd);
    expect(res).toEqual({ ok: true });

    // Atomarer Claim nur aus DRAFT/SENT heraus.
    expect(tx.powerOfAttorney.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f',
          status: { in: ['DRAFT', 'SENT'] },
          updatedAt: new Date('2026-08-20T10:00:00.000Z'),
        },
      }),
    );
    const { data } = tx.powerOfAttorney.updateMany.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.status).toBe('SENT');
    expect(data.signingOtpAttempts).toBe(0);
    expect(data.signingOtpAttemptsTotal).toBe(0);
    expect(data.signingOtpHash).toBeNull();
    expect(data.signingContentSnapshot).toEqual(expect.any(String));
    expect(Buffer.from(data.signingContentSha256 as Uint8Array)).toHaveLength(32);
  });

  it('verweigert Versand für Nicht-ADMIN/PARTNER', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    m.isStaffAdmin.mockReturnValue(false);
    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('expectedUpdatedAt', '2026-08-20T10:00:00.000Z');
    const res = await sendForSignatureAction(fd);
    expect(res.ok).toBe(false);
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });

  it('Resend schreibt exakt denselben gebundenen Snapshot erneut', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const before = poaRecord({ status: 'SENT' });
    const tx = {
      powerOfAttorney: {
        findUnique: vi.fn().mockResolvedValue(before),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(before),
      },
      documentVersion: { findFirst: vi.fn() },
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', name: 'Kanzlei X' }) },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('expectedUpdatedAt', '2026-08-20T10:00:00.000Z');

    const res = await sendForSignatureAction(fd);

    expect(res).toEqual({ ok: true });
    const data = tx.powerOfAttorney.updateMany.mock.calls[0]![0].data;
    expect(data.signingContentSnapshot).toBe(before.signingContentSnapshot);
    expect(Buffer.from(data.signingContentSha256)).toEqual(
      Buffer.from(before.signingContentSha256 as Uint8Array),
    );
    expect(data.signingDocumentVersionId).toBe(before.signingDocumentVersionId);
  });

  it('verwirft einen zweiten Versand mit demselben Seitenstand', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const tx = {
      powerOfAttorney: {
        findUnique: vi.fn().mockResolvedValue(poaRecord({ status: 'SENT' })),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      documentVersion: { findFirst: vi.fn() },
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', name: 'Kanzlei X' }) },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('expectedUpdatedAt', '2026-08-20T10:00:00.000Z');

    const result = await sendForSignatureAction(fd);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('zwischenzeitlich geändert');
    expect(m.sendTemplateMail).not.toHaveBeenCalled();
  });

  it('bindet beim PDF-Versand die exakte Dokumentversion und deren Hash', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const documentId = '11111111-1111-4111-8111-111111111111';
    const versionId = '22222222-2222-4222-8222-222222222222';
    const documentSha256 = Buffer.alloc(32, 0xab);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: documentId }]),
      powerOfAttorney: {
        findUnique: vi
          .fn()
          .mockResolvedValue(poaRecord({ status: 'DRAFT', documentId, ...noSnapshotFields })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(poaRecord({ status: 'SENT', documentId })),
      },
      documentVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: versionId,
          documentId,
          sha256: documentSha256,
        }),
      },
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', name: 'Kanzlei X' }) },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('expectedUpdatedAt', '2026-08-20T10:00:00.000Z');

    const res = await sendForSignatureAction(fd);

    expect(res).toEqual({ ok: true });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const data = tx.powerOfAttorney.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.signingDocumentVersionId).toBe(versionId);
    expect(JSON.parse(data.signingContentSnapshot as string)).toEqual(
      expect.objectContaining({
        document: {
          documentId,
          versionId,
          sha256: documentSha256.toString('hex'),
        },
        scope: null,
      }),
    );
  });

  it('versendet eine bereits abgelaufene Vollmacht nicht', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const tx = {
      powerOfAttorney: {
        findUnique: vi.fn().mockResolvedValue(
          poaRecord({
            status: 'DRAFT',
            validUntil: new Date('2020-01-01T00:00:00.000Z'),
            ...noSnapshotFields,
          }),
        ),
        updateMany: vi.fn(),
      },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('expectedUpdatedAt', '2026-08-20T10:00:00.000Z');

    const res = await sendForSignatureAction(fd);

    expect(res.ok).toBe(false);
    expect(tx.powerOfAttorney.updateMany).not.toHaveBeenCalled();
  });
});

describe('revokePoaAction — Rollen-Gate', () => {
  it('verweigert Widerruf für Nicht-ADMIN/PARTNER vor dem Datensatz-Lookup', async () => {
    const tx = {
      $queryRaw: vi.fn(),
      powerOfAttorney: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    m.isStaffAdmin.mockReturnValue(false);
    m.withStaff.mockImplementation(async (fn: (txArg: unknown, ctx: unknown) => unknown) =>
      fn(tx, {
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        session: {},
      }),
    );
    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('reason', 'Mandant hat widerrufen');

    await expect(revokePoaAction(fd)).rejects.toThrow(
      'Vollmachten dürfen nur von ADMIN/PARTNER widerrufen werden.',
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.powerOfAttorney.findUnique).not.toHaveBeenCalled();
  });

  it('schreibt den Widerrufszeitpunkt atomar mit der PostgreSQL-Uhr', async () => {
    const poaId = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ clientId: 'client-1', status: 'SENT' }])
      .mockResolvedValueOnce([{ id: poaId }]);
    const update = vi.fn();
    const tx = {
      $queryRaw: queryRaw,
      powerOfAttorney: {
        findUnique: vi.fn().mockResolvedValue({ clientId: 'client-1', status: 'SENT' }),
        update,
      },
      notification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    m.withStaff.mockImplementation(async (fn: (txArg: unknown, ctx: unknown) => unknown) =>
      fn(tx, {
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        session: {},
      }),
    );
    const fd = new FormData();
    fd.set('poaId', poaId);
    fd.set('reason', 'Mandant hat widerrufen');

    await revokePoaAction(fd);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const lockSql = (queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('');
    const updateSql = (queryRaw.mock.calls[1]![0] as TemplateStringsArray).join('');
    expect(lockSql).toContain('FOR UPDATE');
    expect(lockSql).toContain('"tenant_id" =');
    expect(updateSql).toContain('"revoked_at" = statement_timestamp()');
    expect(updateSql).toContain('"status" = \'REVOKED\'');
    expect(updateSql).toContain('"status" <> \'REVOKED\'');
    expect(updateSql).toContain('"tenant_id" =');
    expect(update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'poa.revoke',
        resourceId: poaId,
      }),
    );
  });

  it('bricht ohne Evidenz ab, wenn das atomare UPDATE keine Zeile liefert', async () => {
    const poaId = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ clientId: 'client-1', status: 'SENT' }])
        .mockResolvedValueOnce([]),
    };
    m.withStaff.mockImplementation(async (fn: (txArg: unknown, ctx: unknown) => unknown) =>
      fn(tx, {
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        session: {},
      }),
    );
    const fd = new FormData();
    fd.set('poaId', poaId);
    fd.set('reason', 'Mandant hat widerrufen');

    await expect(revokePoaAction(fd)).rejects.toThrow(
      'Vollmacht konnte nicht widerrufen werden. Bitte laden Sie neu.',
    );
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('createPoaAction — Rückkehr aus dem Onboarding', () => {
  function prepareSuccessfulCreate() {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f' }]),
      powerOfAttorney: {
        create: vi.fn().mockResolvedValue({
          id: '8d6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e7a',
        }),
      },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );
    return tx;
  }

  it('kehrt nach erfolgreicher Anlage in den PoA-Schritt desselben Mandanten zurück', async () => {
    prepareSuccessfulCreate();

    await createPoaAction(null, validMarkdownPoaFormData('onboarding'));

    expect(m.redirect).toHaveBeenCalledWith(
      '/staff/clients/onboarding/7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f?step=poa',
    );
    expect(m.revalidatePath).toHaveBeenCalledWith(
      '/staff/clients/onboarding/7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f',
    );
  });

  it('weist manipulierte Return-Ziele vor jedem Datenbankzugriff zurück', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });

    const result = await createPoaAction(
      null,
      validMarkdownPoaFormData('https://evil.example/redirect'),
    );

    expect(result.ok).toBe(false);
    expect(m.readModules).not.toHaveBeenCalled();
    expect(m.withTenantContext).not.toHaveBeenCalled();
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it('führt die normale Anlage weiterhin zur Vollmachtsdetailseite', async () => {
    prepareSuccessfulCreate();

    await createPoaAction(null, validMarkdownPoaFormData());

    expect(m.redirect).toHaveBeenCalledWith('/staff/poa/8d6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e7a');
    expect(m.revalidatePath).toHaveBeenCalledTimes(1);
    expect(m.revalidatePath).toHaveBeenCalledWith('/staff/poa');
  });
});

describe('createPoaAction — Datumsintervall', () => {
  it('verweigert validUntil vor validFrom bereits serverseitig', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const fd = new FormData();
    fd.set('clientId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('uploadIntentId', UPLOAD_INTENT_ID);
    fd.set('signerEmail', 'signer@example.de');
    fd.set('signerName', 'Sina Signer');
    fd.set('subject', 'Vollmacht');
    fd.set('scope', 'Vertretung');
    fd.set('validFrom', '2026-08-10');
    fd.set('validUntil', '2026-08-09');
    const res = await createPoaAction(null, fd);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('darf nicht vor');
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });

  it('legt an beendeten oder anonymisierten Mandaten keine neuen Signerdaten an', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const tx = {
      client: { findFirst: vi.fn().mockResolvedValue(null) },
      clientContact: { findFirst: vi.fn() },
      powerOfAttorney: { create: vi.fn() },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );
    m.readModules.mockResolvedValue({ poaMode: 'PDF_TEMPLATE' });
    const fd = new FormData();
    fd.set('clientId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('uploadIntentId', UPLOAD_INTENT_ID);
    fd.set('signerEmail', 'signer@example.de');
    fd.set('signerName', 'Sina Signer');
    fd.set('subject', 'Vollmacht');
    fd.set('scope', 'Vertretung');
    fd.set('validFrom', '2026-08-10');
    fd.set(
      'poaPdf',
      new File([Buffer.from('%PDF-1.7\n')], 'vollmacht.pdf', { type: 'application/pdf' }),
    );

    const res = await createPoaAction(null, fd);

    expect(res).toEqual({
      ok: false,
      error:
        'Fuer ein beendetes oder anonymisiertes Mandat kann keine neue Vollmacht angelegt werden.',
    });
    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, {}, fd.get('clientId'));
    expect(tx.client.findFirst).toHaveBeenCalledWith({
      where: {
        id: fd.get('clientId'),
        anonymizedAt: null,
        mandateEndedAt: null,
      },
      select: { id: true },
    });
    expect(m.prepareBytesCommitWithTier).not.toHaveBeenCalled();
    expect(m.commitPreparedBytes).not.toHaveBeenCalled();
    expect(tx.powerOfAttorney.create).not.toHaveBeenCalled();
  });

  it('schreibt bei fehlendem Mandatszugriff kein unveraenderbares PDF', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    const tx = {
      client: { findFirst: vi.fn() },
      clientContact: { findFirst: vi.fn() },
      powerOfAttorney: { create: vi.fn() },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );
    m.readModules.mockResolvedValue({ poaMode: 'PDF_TEMPLATE' });
    m.assertClientAccessTx.mockRejectedValueOnce(new m.ActionError('Kein Zugriff.'));
    const fd = new FormData();
    fd.set('clientId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    fd.set('uploadIntentId', UPLOAD_INTENT_ID);
    fd.set('signerEmail', 'signer@example.de');
    fd.set('signerName', 'Sina Signer');
    fd.set('subject', 'Vollmacht');
    fd.set('validFrom', '2026-08-10');
    fd.set(
      'poaPdf',
      new File([Buffer.from('%PDF-1.7\n')], 'vollmacht.pdf', { type: 'application/pdf' }),
    );

    const res = await createPoaAction(null, fd);

    expect(res).toEqual({ ok: false, error: 'Kein Zugriff.' });
    expect(m.prepareBytesCommitWithTier).not.toHaveBeenCalled();
    expect(m.commitPreparedBytes).not.toHaveBeenCalled();
    expect(tx.client.findFirst).not.toHaveBeenCalled();
    expect(tx.powerOfAttorney.create).not.toHaveBeenCalled();
  });

  it('behält das PDF nachvollziehbar, wenn erst die PoA-Transaktion scheitert', async () => {
    const events: string[] = [];
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    m.readModules.mockResolvedValue({ poaMode: 'PDF_TEMPLATE' });
    m.prepareBytesCommitWithTier.mockImplementation(async () => PREPARED_PDF);
    m.commitPreparedBytes.mockImplementation(async () => {
      events.push('put');
      return COMMITTED_PDF;
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'client-1' }]),
      client: { findFirst: vi.fn().mockResolvedValue({ id: 'client-1' }) },
      clientContact: { findFirst: vi.fn() },
      document: {
        create: vi.fn().mockImplementation(async () => {
          events.push('document-pending');
          return { id: 'document-pending' };
        }),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            versions: [
              {
                id: 'version-pending',
                immutable: true,
                scanStatus: 'CLEAN',
                storageVersionId: 'storage-version-1',
              },
            ],
          }),
      },
      documentVersion: {
        create: vi.fn().mockImplementation(async () => {
          events.push('version-pending');
          return { id: 'version-pending' };
        }),
        updateMany: vi.fn().mockImplementation(async () => {
          events.push('version-clean');
          return { count: 1 };
        }),
        findFirst: vi.fn().mockResolvedValue({ id: 'version-pending' }),
      },
      powerOfAttorney: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async () => {
          events.push('poa-failed');
          throw new Error('database unavailable');
        }),
      },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );

    const res = await createPoaAction(null, validPdfPoaFormData());

    expect(res).toEqual({
      ok: false,
      error:
        'Anlegen fehlgeschlagen. Das PDF bleibt nachvollziehbar in der Mandantenakte gespeichert.',
      pendingDocumentId: 'document-pending',
    });
    expect(events).toEqual([
      'document-pending',
      'version-pending',
      'put',
      'version-clean',
      'poa-failed',
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    const lifecycleLocks = tx.$queryRaw.mock.calls.filter(([sql]) =>
      (sql as TemplateStringsArray).join('').includes('"mandate_ended_at" IS NULL'),
    );
    expect(lifecycleLocks).toHaveLength(2);
    for (const [sql] of lifecycleLocks) {
      const source = (sql as TemplateStringsArray).join('');
      expect(source).toContain('FOR UPDATE');
      expect(source).toContain('"mandate_ended_at" IS NULL');
      expect(source).toContain('"anonymized_at" IS NULL');
    }
    expect(tx.documentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storageKey: PREPARED_PDF.targetKey,
        storageVersionId: null,
        immutable: true,
        scanStatus: 'PENDING',
      }),
    });
    expect(tx.documentVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storageVersionId: COMMITTED_PDF.storageVersionId,
          immutable: true,
          scanStatus: 'CLEAN',
        }),
      }),
    );
    expect(m.evidenceRecord.mock.calls.map((call) => call[1]?.action)).toEqual([
      'document.upload.pending',
      'document.upload.complete',
    ]);
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it('lässt bei einem Object-Store-Fehler eine auffindbare PENDING-Spur zurück', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    m.readModules.mockResolvedValue({ poaMode: 'PDF_TEMPLATE' });
    m.commitPreparedBytes.mockRejectedValueOnce(new Error('storage unavailable'));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'client-1' }]),
      client: { findFirst: vi.fn().mockResolvedValue({ id: 'client-1' }) },
      clientContact: { findFirst: vi.fn() },
      document: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'document-pending' }),
      },
      documentVersion: {
        create: vi.fn().mockResolvedValue({ id: 'version-pending' }),
        updateMany: vi.fn(),
        findFirst: vi.fn(),
      },
      powerOfAttorney: { create: vi.fn() },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );

    const res = await createPoaAction(null, validPdfPoaFormData());

    expect(res).toEqual({
      ok: false,
      error:
        'Upload noch nicht abgeschlossen. Sie können den Vorgang mit derselben PDF sicher fortsetzen.',
      pendingDocumentId: 'document-pending',
    });
    expect(tx.document.create).toHaveBeenCalledTimes(1);
    expect(tx.documentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storageKey: PREPARED_PDF.targetKey,
        scanStatus: 'PENDING',
      }),
    });
    expect(tx.documentVersion.updateMany).not.toHaveBeenCalled();
    expect(tx.powerOfAttorney.create).not.toHaveBeenCalled();
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'document.upload.pending',
        resourceId: 'document-pending',
      }),
    );
  });

  it('nimmt nach Antwortverlust denselben stabilen Upload-Intent ohne neuen PUT wieder auf', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: {},
    });
    m.readModules.mockResolvedValue({ poaMode: 'PDF_TEMPLATE' });
    m.recoverPreparedBytesCommit.mockResolvedValue(COMMITTED_PDF);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
      client: { findFirst: vi.fn().mockResolvedValue({ id: 'client-1' }) },
      clientContact: { findFirst: vi.fn() },
      document: {
        create: vi.fn(),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: UPLOAD_INTENT_ID })
          .mockResolvedValueOnce({
            id: UPLOAD_INTENT_ID,
            retentionUntil: PREPARED_PDF.retentionUntil,
            versions: [
              {
                id: 'version-pending',
                versionNo: 1,
                storageBucket: PREPARED_PDF.targetBucket,
                storageKey: PREPARED_PDF.targetKey,
                storageVersionId: null,
                sha256: PREPARED_PDF.sha256,
                sizeBytes: PREPARED_PDF.sizeBytes,
                immutable: true,
                scanStatus: 'PENDING',
                scanCompletedAt: null,
              },
            ],
          })
          .mockResolvedValueOnce({
            versions: [
              {
                id: 'version-pending',
                immutable: true,
                scanStatus: 'CLEAN',
                storageVersionId: COMMITTED_PDF.storageVersionId,
              },
            ],
          }),
      },
      documentVersion: {
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      powerOfAttorney: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'poa-resumed' }),
      },
    };
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );
    const fd = validPdfPoaFormData();
    fd.delete('poaPdf');

    await createPoaAction(null, fd);

    expect(m.recoverPreparedBytesCommit).toHaveBeenCalledWith(PREPARED_PDF);
    expect(m.prepareBytesCommitWithTier).not.toHaveBeenCalled();
    expect(m.commitPreparedBytes).not.toHaveBeenCalled();
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(tx.documentVersion.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.powerOfAttorney.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentId: UPLOAD_INTENT_ID }),
      }),
    );
    expect(m.redirect).toHaveBeenCalledWith('/staff/poa/poa-resumed');
  });
});
