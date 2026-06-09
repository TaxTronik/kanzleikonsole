// =============================================================================
// Unit-Tests: Magic-Link-Service (apps/web/src/server/auth/magic-link.ts).
//
// Prisma/SMTP/Redis/Notifications sind fest verdrahtet → komplett gemockt
// (Muster wie rbac.test.ts / n8n/verify.test.ts). Echte Logik im Test:
// Token-Hashing (SHA-256), Ablauf-/Consume-Checks, Anti-Enumeration.
//
// Abgedeckt:
//   - hashToken: deterministisch, bekannter Vektor
//   - requestMagicLink: Throttle/unbekannter Tenant/unbekannter Contact →
//     IMMER ok:true ohne Mail (Anti-Enumeration), Happy-Path speichert NUR
//     den Hash (nie den rohen Token), TTL 30 min, SMTP-Fehler wird geschluckt
//   - verifyMagicLink: zu kurz/unbekannt/konsumiert/abgelaufen → null,
//     One-Time-Use über atomares updateMany (Race → null)
//
// Anti-Timing-Delays (setTimeout 250–500 ms) laufen über die Fake-Clock —
// Promise starten, Timer abspulen, dann auflösen.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  sendTemplateMail: vi.fn(),
  checkRateLimit: vi.fn(),
  notify: vi.fn(),
  withTenantContext: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  prismaOwner: {
    tenant: { findUnique: vi.fn() },
    clientContact: { findFirst: vi.fn(), update: vi.fn() },
    magicLink: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: m.sendTemplateMail }));
vi.mock('@taxtronik/config', () => ({
  env: { NODE_ENV: 'production' },
  portalBaseUrl: 'https://portal.example.de',
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: m.prismaOwner }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/notifications/service', () => ({ notify: m.notify }));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: m.checkRateLimit }));

import { hashToken, requestMagicLink, verifyMagicLink } from '../magic-link';

const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');
const TTL_MS = 30 * 60 * 1000;

const TENANT = { id: 'tenant-1', name: 'Kanzlei X' };
const CONTACT = {
  id: 'contact-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  email: 'mandant@example.de',
  fullName: 'Max Mandant',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  // Happy-Path-Defaults — einzelne Tests verstellen gezielt.
  m.checkRateLimit.mockResolvedValue({ ok: true });
  m.prismaOwner.tenant.findUnique.mockResolvedValue(TENANT);
  m.prismaOwner.clientContact.findFirst.mockResolvedValue(CONTACT);
  m.prismaOwner.clientContact.update.mockResolvedValue({});
  m.prismaOwner.magicLink.create.mockResolvedValue({});
  m.prismaOwner.magicLink.updateMany.mockResolvedValue({ count: 1 });
  m.sendTemplateMail.mockResolvedValue(undefined);
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  );
  m.notify.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Promise starten, Anti-Timing-Timer abspulen, Ergebnis auflösen. */
async function withTimersFlushed<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

// -----------------------------------------------------------------------------
// hashToken
// -----------------------------------------------------------------------------

describe('hashToken', () => {
  it('SHA-256 hex — bekannter Vektor', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('deterministisch und 64 hex-Zeichen', () => {
    const h = hashToken('irgendein-token');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('irgendein-token')).toBe(h);
    expect(hashToken('anderes-token')).not.toBe(h);
  });
});

// -----------------------------------------------------------------------------
// requestMagicLink — Anti-Enumeration
// -----------------------------------------------------------------------------

describe('requestMagicLink — Anti-Enumeration (immer ok:true)', () => {
  it('gedrosselt (Rate-Limit) → ok:true, KEIN Token, KEINE Mail', async () => {
    m.checkRateLimit.mockResolvedValue({ ok: false });
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
    );
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.magicLink.create).not.toHaveBeenCalled();
    expect(m.sendTemplateMail).not.toHaveBeenCalled();
  });

  it('unbekannter Tenant → ok:true, KEIN Token', async () => {
    m.prismaOwner.tenant.findUnique.mockResolvedValue(null);
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'gibt-es-nicht', email: 'mandant@example.de' }),
    );
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.magicLink.create).not.toHaveBeenCalled();
    expect(m.sendTemplateMail).not.toHaveBeenCalled();
  });

  it('unbekannter Contact → ok:true, KEIN Token', async () => {
    m.prismaOwner.clientContact.findFirst.mockResolvedValue(null);
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'unbekannt@example.de' }),
    );
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.magicLink.create).not.toHaveBeenCalled();
    expect(m.sendTemplateMail).not.toHaveBeenCalled();
  });

  it('SMTP-Fehler wird geschluckt → trotzdem ok:true, Ops-Log + Notification', async () => {
    m.sendTemplateMail.mockRejectedValue(new Error('smtp down'));
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
    );
    expect(res).toEqual({ ok: true });
    expect(m.log.error).toHaveBeenCalled();
    expect(m.notify).toHaveBeenCalled();
  });

  it('auch ein Notification-Fehler nach SMTP-Fehler bricht den Flow nicht', async () => {
    m.sendTemplateMail.mockRejectedValue(new Error('smtp down'));
    m.withTenantContext.mockRejectedValue(new Error('db down'));
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
    );
    expect(res).toEqual({ ok: true });
  });
});

describe('requestMagicLink — Happy Path', () => {
  it('speichert NUR den SHA-256-Hash, TTL 30 min; roher Token nur im Mail-Link', async () => {
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
    );
    expect(res).toEqual({ ok: true });

    expect(m.prismaOwner.magicLink.create).toHaveBeenCalledTimes(1);
    const createArgs = m.prismaOwner.magicLink.create.mock.calls[0]![0] as {
      data: { tenantId: string; email: string; tokenHash: string; expiresAt: Date };
    };
    expect(createArgs.data.tenantId).toBe('tenant-1');
    expect(createArgs.data.email).toBe(CONTACT.email);
    expect(createArgs.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createArgs.data.expiresAt).toEqual(new Date(FIXED_NOW.getTime() + TTL_MS));

    expect(m.sendTemplateMail).toHaveBeenCalledTimes(1);
    const mailArgs = m.sendTemplateMail.mock.calls[0]![0] as {
      to: string;
      vars: { link: string };
    };
    expect(mailArgs.to).toBe(CONTACT.email);
    expect(mailArgs.vars.link).toMatch(
      /^https:\/\/portal\.example\.de\/portal\/login\/verify\?token=/,
    );

    // Der Link enthält den ROHEN Token; sein Hash muss exakt dem gespeicherten
    // tokenHash entsprechen — und der rohe Token darf NIE in der DB landen.
    const rawToken = new URL(mailArgs.vars.link).searchParams.get('token')!;
    expect(rawToken.length).toBeGreaterThanOrEqual(32);
    expect(hashToken(rawToken)).toBe(createArgs.data.tokenHash);
    expect(JSON.stringify(createArgs)).not.toContain(rawToken);
  });

  it('E-Mail wird für Lookup und Throttle-Key lowercased', async () => {
    await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'Mandant@Example.DE' }),
    );
    expect(m.checkRateLimit).toHaveBeenCalledWith(
      'magic-link-issue:tenant-1:mandant@example.de',
      expect.anything(),
    );
    expect(m.prismaOwner.clientContact.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', email: 'mandant@example.de', active: true },
    });
  });
});

// -----------------------------------------------------------------------------
// verifyMagicLink
// -----------------------------------------------------------------------------

const RAW_TOKEN = 'raw-token-with-sufficient-length-0123456789';

function linkRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'link-1',
    tenantId: 'tenant-1',
    email: CONTACT.email,
    tokenHash: hashToken(RAW_TOKEN),
    consumedAt: null,
    expiresAt: new Date(FIXED_NOW.getTime() + 5 * 60 * 1000),
    ...overrides,
  };
}

describe('verifyMagicLink', () => {
  it('zu kurzer Token (< 16 Zeichen) → null ohne DB-Zugriff', async () => {
    expect(await verifyMagicLink('kurz')).toBeNull();
    expect(await verifyMagicLink('')).toBeNull();
    expect(m.prismaOwner.magicLink.findFirst).not.toHaveBeenCalled();
  });

  it('Lookup läuft über den HASH des Tokens, nie den Klartext', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord());
    await verifyMagicLink(RAW_TOKEN);
    expect(m.prismaOwner.magicLink.findFirst).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(RAW_TOKEN) },
    });
  });

  it('unbekannter Token → null', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(null);
    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
  });

  it('bereits konsumiert → null (One-Time-Use)', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(
      linkRecord({ consumedAt: new Date(FIXED_NOW.getTime() - 1000) }),
    );
    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
    expect(m.prismaOwner.magicLink.updateMany).not.toHaveBeenCalled();
  });

  it('abgelaufen → null', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(
      linkRecord({ expiresAt: new Date(FIXED_NOW.getTime() - 1000) }),
    );
    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
    expect(m.prismaOwner.magicLink.updateMany).not.toHaveBeenCalled();
  });

  it('Contact existiert nicht mehr / inaktiv → null', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord());
    m.prismaOwner.clientContact.findFirst.mockResolvedValue(null);
    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
  });

  it('Race: updateMany trifft 0 Zeilen (parallel konsumiert) → null', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord());
    m.prismaOwner.magicLink.updateMany.mockResolvedValue({ count: 0 });
    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
  });

  it('Happy Path: Contact zurück, Token atomar als consumed markiert', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord());
    const res = await verifyMagicLink(RAW_TOKEN);
    expect(res).toEqual({
      contact: {
        id: CONTACT.id,
        tenantId: CONTACT.tenantId,
        clientId: CONTACT.clientId,
        email: CONTACT.email,
        fullName: CONTACT.fullName,
      },
    });
    // Atomarer Claim: nur wenn consumedAt noch null ist (Race-Schutz).
    expect(m.prismaOwner.magicLink.updateMany).toHaveBeenCalledWith({
      where: { id: 'link-1', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    // Fire-and-forget: lastLoginAt-Update wurde angestoßen.
    expect(m.prismaOwner.clientContact.update).toHaveBeenCalledWith({
      where: { id: CONTACT.id },
      data: { lastLoginAt: expect.any(Date) },
    });
  });
});
