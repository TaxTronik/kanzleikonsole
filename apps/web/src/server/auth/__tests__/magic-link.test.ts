// =============================================================================
// Unit-Tests: Magic-Link-Service (apps/web/src/server/auth/magic-link.ts).
//
// Prisma/SMTP/Redis/Notifications sind fest verdrahtet → komplett gemockt
// (Muster wie rbac.test.ts / n8n/verify.test.ts). Echte Logik im Test:
// Token-Hashing (SHA-256), Ablauf-/Consume-Checks, Anti-Enumeration.
//
// Abgedeckt:
//   - hashToken: deterministisch, bekannter Vektor
//   - requestMagicLink: Throttle/unbekannter Tenant/unbekannter Contact/
//     GwG-deaktivierter Mandant (client.allowActive=false) → IMMER ok:true
//     ohne Mail (Anti-Enumeration), Happy-Path speichert NUR den Hash (nie
//     den rohen Token), TTL 30 min, SMTP-Fehler wird geschluckt
//   - verifyMagicLink: zu kurz/unbekannt/konsumiert/abgelaufen/Mandant
//     GwG-deaktiviert → null, One-Time-Use über atomares updateMany (Race → null)
//
// Anti-Timing-Delays (setTimeout 250–500 ms) laufen über die Fake-Clock —
// Promise starten, Timer abspulen, dann auflösen.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  sendTemplateMail: vi.fn(),
  checkRateLimit: vi.fn(),
  notifyMany: vi.fn(),
  filterStaffAccessClientTx: vi.fn(),
  resolveNotificationsTx: vi.fn(),
  withTenantContext: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // RF-12: Audit-Record beim Magic-Link-Consume (auth.magic_link.consume)
  evidenceRecord: vi.fn(),
  prismaOwner: {
    tenant: { findUnique: vi.fn() },
    staffUser: { findMany: vi.fn() },
    clientContact: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    magicLink: { create: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: m.sendTemplateMail }));
vi.mock('@taxtronik/config', () => ({
  env: { NODE_ENV: 'production' },
  portalBaseUrl: 'https://portal.example.de',
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: m.prismaOwner }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: m.resolveNotificationsTx,
}));
vi.mock('@/server/notifications/service', () => ({ notifyMany: m.notifyMany }));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock('@/server/auth/rbac', () => ({
  filterStaffAccessClientTx: m.filterStaffAccessClientTx,
}));

import { hashToken, inspectMagicLink, requestMagicLink, verifyMagicLink } from '../magic-link';

const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');
const TTL_MS = 30 * 60 * 1000;

const TENANT = { id: 'tenant-1', name: 'Kanzlei X' };
const CONTACT = {
  id: 'contact-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  email: 'mandant@example.de',
  fullName: 'Max Mandant',
  active: true,
  // GwG-Schranke: der Parent-Client wird per include mitgeladen.
  client: { name: 'Muster GmbH', allowActive: true, anonymizedAt: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  // Happy-Path-Defaults — einzelne Tests verstellen gezielt.
  m.checkRateLimit.mockResolvedValue({ ok: true });
  m.prismaOwner.tenant.findUnique.mockResolvedValue(TENANT);
  m.prismaOwner.staffUser.findMany.mockResolvedValue([{ id: 'staff-1' }, { id: 'staff-2' }]);
  m.prismaOwner.clientContact.findFirst.mockResolvedValue(CONTACT);
  m.prismaOwner.clientContact.findMany.mockResolvedValue([CONTACT]);
  m.prismaOwner.clientContact.findUnique.mockResolvedValue(CONTACT);
  m.prismaOwner.clientContact.update.mockResolvedValue({});
  m.prismaOwner.magicLink.create.mockResolvedValue({});
  m.prismaOwner.magicLink.updateMany.mockResolvedValue({ count: 1 });
  // RF-12: der Consume läuft in einer Tx (updateMany + Audit-Record) —
  // der Mock reicht prismaOwner selbst als Tx-Client durch.
  m.prismaOwner.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(m.prismaOwner),
  );
  m.evidenceRecord.mockResolvedValue({});
  m.prismaOwner.magicLink.deleteMany.mockResolvedValue({ count: 1 });
  m.sendTemplateMail.mockResolvedValue({ ok: true, sentViaTemplate: false });
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn(m.prismaOwner),
  );
  m.notifyMany.mockResolvedValue(undefined);
  m.filterStaffAccessClientTx.mockResolvedValue(new Set(['staff-1']));
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
    m.prismaOwner.clientContact.findMany.mockResolvedValue([]);
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'unbekannt@example.de' }),
    );
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.magicLink.create).not.toHaveBeenCalled();
    expect(m.sendTemplateMail).not.toHaveBeenCalled();
  });

  it('Mandant GwG-deaktiviert (allowActive=false) → ok:true, KEIN Token, KEINE Mail', async () => {
    // GwG-Schranke (§ 11 GwG): identisches Verhalten wie „Contact unbekannt" —
    // kein unterscheidbarer Fehler, sonst wäre der Sperr-Status enumerierbar.
    // Der Helper filtert allowActive bereits in der DB-Abfrage; Prisma liefert
    // für einen gesperrten Parent daher keine auswählbaren Profile.
    m.prismaOwner.clientContact.findMany.mockResolvedValue([]);
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
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
    expect(m.prismaOwner.magicLink.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), consumedAt: null },
    });
    expect(m.filterStaffAccessClientTx).toHaveBeenCalledWith(
      m.prismaOwner,
      'tenant-1',
      ['staff-1', 'staff-2'],
      CONTACT.clientId,
    );
    expect(m.notifyMany).toHaveBeenCalledWith(
      m.prismaOwner,
      ['staff-1'],
      expect.objectContaining({
        resourceType: 'client_contact',
        resourceId: CONTACT.id,
        href: `/staff/clients/${CONTACT.clientId}`,
      }),
    );
    const notification = m.notifyMany.mock.calls[0]![2] as { body: string };
    expect(notification.body).not.toContain(CONTACT.email);
  });

  it('sendTemplateMail ok:false invalidiert den erzeugten Token ebenfalls', async () => {
    m.sendTemplateMail.mockResolvedValue({ ok: false, sentViaTemplate: false });
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
    );
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.magicLink.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), consumedAt: null },
    });
    expect(m.notifyMany).toHaveBeenCalled();
  });

  it('legt ohne zugriffsberechtigte Mitarbeiter keine globale Fehler-Notification an', async () => {
    m.sendTemplateMail.mockRejectedValue(new Error('smtp down'));
    m.filterStaffAccessClientTx.mockResolvedValue(new Set());

    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
    );

    expect(res).toEqual({ ok: true });
    expect(m.notifyMany).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith(
      { contactId: CONTACT.id, clientId: CONTACT.clientId },
      expect.stringContaining('kein zugriffsberechtigter Empfaenger'),
    );
  });

  it('auch ein Notification-Fehler nach SMTP-Fehler bricht den Flow nicht', async () => {
    m.sendTemplateMail.mockRejectedValue(new Error('smtp down'));
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn(m.prismaOwner),
      )
      .mockRejectedValueOnce(new Error('db down'));
    const res = await withTimersFlushed(
      requestMagicLink({ tenantId: 'tenant-1', email: 'mandant@example.de' }),
    );
    expect(res).toEqual({ ok: true });
    expect(m.prismaOwner.magicLink.deleteMany).toHaveBeenCalled();
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
      data: {
        tenantId: string;
        contactId: string | null;
        email: string;
        tokenHash: string;
        expiresAt: Date;
      };
    };
    expect(createArgs.data.tenantId).toBe('tenant-1');
    // Portal-Login: E-Mail-gebundener Link, Profil wird erst nach dem Klick gewählt.
    expect(createArgs.data.contactId).toBeNull();
    expect(createArgs.data.email).toBe(CONTACT.email);
    expect(createArgs.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createArgs.data.expiresAt).toEqual(new Date(FIXED_NOW.getTime() + TTL_MS));

    expect(m.sendTemplateMail).toHaveBeenCalledTimes(1);
    const mailArgs = m.sendTemplateMail.mock.calls[0]![0] as {
      to: string;
      vars: { link: string };
      subjectSuffix: string;
      fallback: { bodyMd: string };
    };
    expect(mailArgs.to).toBe(CONTACT.email);
    expect(mailArgs.subjectSuffix).toBe(CONTACT.client.name);
    expect(mailArgs.vars.link).toMatch(
      /^https:\/\/portal\.example\.de\/portal\/login\/verify\?token=/,
    );
    expect(mailArgs.fallback.bodyMd).toContain('über den folgenden Link können');
    expect(mailArgs.fallback.bodyMd).toContain('für {{client.name}}');
    expect(mailArgs.fallback.bodyMd).toContain('Minuten gültig');

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
    expect(m.prismaOwner.clientContact.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        email: 'mandant@example.de',
        active: true,
        client: { allowActive: true, anonymizedAt: null },
      },
      select: {
        id: true,
        clientId: true,
        fullName: true,
        email: true,
        client: { select: { name: true } },
      },
      orderBy: [{ client: { name: 'asc' } }, { createdAt: 'asc' }],
    });
  });

  it('sendet bei mehreren Mandantenprofilen genau einen Auswahl-Link', async () => {
    m.prismaOwner.clientContact.findMany.mockResolvedValue([
      CONTACT,
      {
        ...CONTACT,
        id: 'contact-2',
        clientId: 'client-2',
        client: { ...CONTACT.client, name: 'Zweite GbR' },
      },
    ]);

    await requestMagicLink({ tenantId: 'tenant-1', email: CONTACT.email });

    expect(m.prismaOwner.magicLink.create).toHaveBeenCalledTimes(1);
    expect(m.sendTemplateMail).toHaveBeenCalledTimes(1);
    expect(m.prismaOwner.magicLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: null }),
    });
    expect(m.sendTemplateMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectSuffix: '2 Mandantenprofile',
        vars: expect.objectContaining({ profileCount: 2 }),
      }),
    );
  });

  it('Staff-Versand bleibt exakt an den gewählten Kontakt gebunden', async () => {
    m.prismaOwner.clientContact.findMany.mockResolvedValue([
      CONTACT,
      {
        ...CONTACT,
        id: 'contact-2',
        clientId: 'client-2',
        client: { ...CONTACT.client, name: 'Zweite GbR' },
      },
    ]);

    await requestMagicLink({
      tenantId: 'tenant-1',
      email: CONTACT.email,
      contactId: CONTACT.id,
    });

    expect(m.prismaOwner.magicLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: CONTACT.id }),
    });
    expect(m.sendTemplateMail).toHaveBeenCalledWith(
      expect.objectContaining({ subjectSuffix: CONTACT.client.name }),
    );
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
    contactId: CONTACT.id,
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
    m.prismaOwner.clientContact.findMany.mockResolvedValue([]);
    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
  });

  it('Mandant GwG-deaktiviert (allowActive=false) → null, Token wird NICHT konsumiert', async () => {
    // GwG-Schranke (§ 11 GwG): Mandant zwischen Request und Klick deaktiviert
    // (GwG abgelaufen/abgelehnt) → Login verweigert, ununterscheidbar vom
    // unbekannten/inaktiven Kontakt.
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord());
    m.prismaOwner.clientContact.findMany.mockResolvedValue([]);
    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
    expect(m.prismaOwner.magicLink.updateMany).not.toHaveBeenCalled();
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

  it('zeigt bei einem E-Mail-Link alle Profile an, ohne den Token zu konsumieren', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord({ contactId: null }));
    m.prismaOwner.clientContact.findMany.mockResolvedValue([
      CONTACT,
      {
        ...CONTACT,
        id: 'contact-2',
        clientId: 'client-2',
        client: { ...CONTACT.client, name: 'Zweite GbR' },
      },
    ]);

    const result = await inspectMagicLink(RAW_TOKEN);

    expect(result?.profiles.map((profile) => profile.clientName)).toEqual([
      'Muster GmbH',
      'Zweite GbR',
    ]);
    expect(m.prismaOwner.magicLink.updateMany).not.toHaveBeenCalled();
  });

  it('verlangt bei einem E-Mail-Link mit mehreren Profilen eine explizite Auswahl', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord({ contactId: null }));
    const second = {
      ...CONTACT,
      id: 'contact-2',
      clientId: 'client-2',
      client: { ...CONTACT.client, name: 'Zweite GbR' },
    };
    m.prismaOwner.clientContact.findMany.mockResolvedValue([CONTACT, second]);

    expect(await verifyMagicLink(RAW_TOKEN)).toBeNull();
    expect(m.prismaOwner.magicLink.updateMany).not.toHaveBeenCalled();

    const selected = await verifyMagicLink(RAW_TOKEN, second.id);
    expect(selected?.contact).toMatchObject({ id: second.id, clientId: second.clientId });
  });

  it('kann einen kontaktgebundenen Link nicht auf ein Schwesterprofil umbiegen', async () => {
    m.prismaOwner.magicLink.findFirst.mockResolvedValue(linkRecord());

    expect(await verifyMagicLink(RAW_TOKEN, 'contact-2')).toBeNull();
    expect(m.prismaOwner.magicLink.updateMany).not.toHaveBeenCalled();
  });
});
