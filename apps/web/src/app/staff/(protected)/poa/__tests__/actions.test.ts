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
    assertClientInTenant: vi.fn(),
    redirect: vi.fn(),
    revalidatePath: vi.fn(),
    headers: vi.fn(),
    prismaOwner: {
      powerOfAttorney: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
  commitBytesWithTier: vi.fn(),
  MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
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
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: m.ActionError,
  staffActionGuard: m.staffActionGuard,
  withStaff: m.withStaff,
}));
vi.mock('@/server/db/assert-tenant', () => ({ assertClientInTenant: m.assertClientInTenant }));
vi.mock('@/server/notifications/service', () => ({ notify: m.notify }));

import {
  requestSigningOtpAction,
  sendForSignatureAction,
  signPoaAction,
} from '../actions';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const RAW_TOKEN = 'poa-signing-token-0123456789abcdef';
const OTP = '123456';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

function poaRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'poa-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    signerContactId: null,
    signerEmail: 'signer@example.de',
    signerName: 'Sina Signer',
    subject: 'Vollmacht Finanzamt',
    status: 'SENT',
    signingTokenHash: sha256(RAW_TOKEN),
    signingTokenExpiresAt: FUTURE,
    signingOtpHash: sha256(OTP),
    signingOtpExpiresAt: FUTURE,
    signingOtpAttempts: 0,
    signingOtpAttemptsTotal: 0,
    createdByStaff: 'staff-1',
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
  m.sendTemplateMail.mockResolvedValue(undefined);
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  );
  m.evidenceRecord.mockResolvedValue({});
  m.notify.mockResolvedValue(undefined);
});

// -----------------------------------------------------------------------------
// signPoaAction — Fehlversuchszähler
// -----------------------------------------------------------------------------

describe('signPoaAction — falsches OTP', () => {
  it('inkrementiert BEIDE Zähler (pro-OTP + Lebenszyklus)', async () => {
    const res = await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999' });
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
    await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999' });
    // Nur der Increment-Call — kein zweiter Update zur Invalidierung.
    expect(m.prismaOwner.powerOfAttorney.update).toHaveBeenCalledTimes(1);
  });

  it('pro-OTP-Cap (5) erreicht → Token + OTP entwertet, Zähler zurückgesetzt', async () => {
    m.prismaOwner.powerOfAttorney.update.mockResolvedValueOnce({
      signingOtpAttempts: 5,
      signingOtpAttemptsTotal: 5,
    });
    await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999' });
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
    await signPoaAction({ rawToken: RAW_TOKEN, otp: '999999' });
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
    const res = await signPoaAction({ rawToken: RAW_TOKEN, otp: OTP });
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.powerOfAttorney.updateMany).toHaveBeenCalledWith({
      where: { id: 'poa-1', status: 'SENT' },
      data: expect.objectContaining({
        status: 'SIGNED',
        signingTokenHash: null,
        signingOtpHash: null,
        signingOtpAttempts: 0,
        signingOtpAttemptsTotal: 0,
      }),
    });
  });
});

// -----------------------------------------------------------------------------
// requestSigningOtpAction — Re-Issue
// -----------------------------------------------------------------------------

describe('requestSigningOtpAction — Re-Issue', () => {
  it('resettet NUR den pro-OTP-Zähler, niemals signingOtpAttemptsTotal', async () => {
    const res = await requestSigningOtpAction(RAW_TOKEN);
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
        findUnique: vi.fn().mockResolvedValue(poaRecord({ status: 'DRAFT' })),
        // Neuer Flow: atomarer Claim via updateMany + Re-Fetch.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(poaRecord({ status: 'SENT' })),
      },
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', name: 'Kanzlei X' }) },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    );

    const fd = new FormData();
    fd.set('poaId', '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f');
    const res = await sendForSignatureAction(fd);
    expect(res).toEqual({ ok: true });

    // Atomarer Claim nur aus DRAFT/SENT heraus.
    expect(tx.powerOfAttorney.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f', status: { in: ['DRAFT', 'SENT'] } },
      }),
    );
    const { data } = tx.powerOfAttorney.updateMany.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.status).toBe('SENT');
    expect(data.signingOtpAttempts).toBe(0);
    expect(data.signingOtpAttemptsTotal).toBe(0);
    expect(data.signingOtpHash).toBeNull();
  });
});
