import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  headers: vi.fn(),
  checkRateLimit: vi.fn(),
  checkIpOrGlobalLimit: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: m.headers }));
vi.mock('@taxtronik/storage', () => ({
  commitDocumentFromBytes: vi.fn(),
  deleteObject: vi.fn(),
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: {} }));
vi.mock('@/server/documents/upload-helpers', () => ({ createDocumentWithVersion: vi.fn() }));
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

import { uploadIdImageAction } from '../actions';
import { GENERIC_TOKEN_ERROR } from '@/server/gwg-onboarding/service';

describe('GwG-Onboarding Ablauf-CAS bei Schreibaktionen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.headers.mockResolvedValue(new Headers());
    m.checkRateLimit.mockResolvedValue({ ok: true });
    m.checkIpOrGlobalLimit.mockResolvedValue({ ok: true });
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
});
