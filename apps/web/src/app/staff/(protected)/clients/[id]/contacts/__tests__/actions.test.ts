// =============================================================================
// Unit-Tests: iCal-Feed-Widerruf (contacts/actions.ts, rotateIcalTokenAction).
//
// icalTokenVersion geht in den Feed-Token-HMAC ein (server/ical/feed.ts); die
// Route vergleicht die Token-Version gegen den DB-Stand — der Increment
// entwertet alle ausgegebenen Feed-URLs NUR dieses Kontakts.
//
// Prisma/Audit/Guard komplett gemockt (Muster magic-link.test.ts /
// poa/__tests__/actions.test.ts). Abgedeckt:
//   - Guard verweigert → Guard-Ergebnis durchgereicht, KEIN DB-Zugriff
//   - ungültige UUIDs → Validierungsfehler ohne Tx
//   - Kontakt unbekannt / falscher Mandant → Fehler, KEIN Increment
//   - Happy Path: atomarer Increment + Audit-Record + Revalidate
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    withTenantContext: vi.fn(),
    evidenceRecord: vi.fn(),
    staffActionGuard: vi.fn(),
    withStaff: vi.fn(),
    requestMagicLink: vi.fn(),
    revokeAllSessions: vi.fn(),
    revalidatePath: vi.fn(),
    tx: {
      clientContact: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/auth/magic-link', () => ({ requestMagicLink: m.requestMagicLink }));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: m.revokeAllSessions }));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (e: unknown) => ({
    ok: false,
    error: e instanceof Error ? e.message : 'Fehler.',
  }),
  // Vertraulich-/RESTRICTED-Ventil (M-1): im Unit-Test No-op = Zugriff gewährt.
  assertClientAccessTx: vi.fn(),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: m.ActionError,
  staffActionGuard: m.staffActionGuard,
  withStaff: m.withStaff,
}));

import { rotateIcalTokenAction, updateContactAction } from '../actions';

const CONTACT_ID = '0b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const CLIENT_ID = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: {},
  });
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
    fn(m.tx),
  );
  m.withStaff.mockImplementation(
    async (fn: (tx: unknown, ctx: Record<string, unknown>) => unknown) => {
      try {
        const data = await fn(m.tx, {
          tenantId: 'tenant-1',
          staffId: 'staff-1',
          session: {},
        });
        return { ok: true, ...(data ?? {}) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );
  m.tx.clientContact.findUnique.mockResolvedValue({ clientId: CLIENT_ID });
  m.tx.clientContact.update.mockResolvedValue({ icalTokenVersion: 2 });
  m.evidenceRecord.mockResolvedValue({});
});

describe('rotateIcalTokenAction — Autorisierung & Validierung', () => {
  it('Guard verweigert → Guard-Ergebnis durchgereicht, KEIN DB-Zugriff', async () => {
    m.staffActionGuard.mockResolvedValue({ ok: false, error: 'Nicht eingeloggt.' });
    const res = await rotateIcalTokenAction({ contactId: CONTACT_ID, clientId: CLIENT_ID });
    expect(res).toEqual({ ok: false, error: 'Nicht eingeloggt.' });
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });

  it('ungültige UUIDs → typisierter Validierungsfehler ohne Tx', async () => {
    const res = await rotateIcalTokenAction({ contactId: 'nicht-uuid', clientId: CLIENT_ID });
    expect(res).toEqual({
      ok: false,
      error: 'Ungültiger Kontakt.',
      errorCode: 'VALIDATION_ERROR',
    });
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });
});

describe('rotateIcalTokenAction — Fehlerfälle', () => {
  it('Kontakt unbekannt → Fehler, KEIN Increment, KEIN Audit-Record', async () => {
    m.tx.clientContact.findUnique.mockResolvedValue(null);
    const res = await rotateIcalTokenAction({ contactId: CONTACT_ID, clientId: CLIENT_ID });
    expect(res).toEqual({ ok: false, error: 'Ansprechpartner nicht gefunden.' });
    expect(m.tx.clientContact.update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it('Kontakt gehört zu anderem Mandanten → Fehler, KEIN Increment', async () => {
    m.tx.clientContact.findUnique.mockResolvedValue({ clientId: 'anderer-mandant' });
    const res = await rotateIcalTokenAction({ contactId: CONTACT_ID, clientId: CLIENT_ID });
    expect(res).toEqual({ ok: false, error: 'Mandant stimmt nicht überein.' });
    expect(m.tx.clientContact.update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('rotateIcalTokenAction — Happy Path', () => {
  it('inkrementiert icalTokenVersion atomar und schreibt den Audit-Record', async () => {
    const res = await rotateIcalTokenAction({ contactId: CONTACT_ID, clientId: CLIENT_ID });
    expect(res).toEqual({ ok: true });

    // Atomarer Increment (kein Read-Modify-Write) — Race-sicher.
    expect(m.tx.clientContact.update).toHaveBeenCalledWith({
      where: { id: CONTACT_ID },
      data: { icalTokenVersion: { increment: 1 } },
      select: { icalTokenVersion: true },
    });

    // Audit-Record läuft in derselben Tx und trägt die NEUE Version.
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord).toHaveBeenCalledWith(m.tx, {
      tenantId: 'tenant-1',
      actorType: 'STAFF',
      actorId: 'staff-1',
      action: 'client_contact.ical_rotate',
      resourceType: 'client_contact',
      resourceId: CONTACT_ID,
      after: { icalTokenVersion: 2 },
    });

    expect(m.revalidatePath).toHaveBeenCalledWith(`/staff/clients/${CLIENT_ID}`);
  });
});

describe('updateContactAction — Portal-Identität', () => {
  it('widerruft bestehende Portal-Sessions vor dem E-Mail-Wechsel', async () => {
    m.tx.clientContact.findUnique.mockResolvedValue({
      fullName: 'Rey Koxha',
      email: 'alt@example.test',
      phone: null,
      role: null,
      clientId: CLIENT_ID,
    });
    m.tx.clientContact.findFirst.mockResolvedValue(null);
    m.tx.clientContact.update.mockResolvedValue({});

    await expect(
      updateContactAction({
        contactId: CONTACT_ID,
        clientId: CLIENT_ID,
        fullName: 'Rey Koxha',
        email: 'NEU@example.test',
        phone: null,
        role: null,
      }),
    ).resolves.toEqual({ ok: true });

    expect(m.tx.clientContact.update).toHaveBeenCalledWith({
      where: { id: CONTACT_ID },
      data: {
        fullName: 'Rey Koxha',
        email: 'neu@example.test',
        phone: null,
        role: null,
        lastLoginAt: null,
      },
    });
    expect(m.revokeAllSessions).toHaveBeenCalledWith('portal', CONTACT_ID);
    expect(m.revokeAllSessions.mock.invocationCallOrder[0]!).toBeLessThan(
      m.tx.clientContact.update.mock.invocationCallOrder[0]!,
    );
  });

  it('schreibt die neue E-Mail nicht, wenn der Session-Widerruf fehlschlägt', async () => {
    m.tx.clientContact.findUnique.mockResolvedValue({
      fullName: 'Rey Koxha',
      email: 'alt@example.test',
      phone: null,
      role: null,
      clientId: CLIENT_ID,
    });
    m.tx.clientContact.findFirst.mockResolvedValue(null);
    m.revokeAllSessions.mockRejectedValueOnce(
      new Error('Session-Widerruf ist derzeit nicht verfügbar.'),
    );

    await expect(
      updateContactAction({
        contactId: CONTACT_ID,
        clientId: CLIENT_ID,
        fullName: 'Rey Koxha',
        email: 'neu@example.test',
        phone: null,
        role: null,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Session-Widerruf ist derzeit nicht verfügbar.',
    });
    expect(m.tx.clientContact.update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('widerruft bei unveränderter normalisierter E-Mail keine Portal-Sessions', async () => {
    m.tx.clientContact.findUnique.mockResolvedValue({
      fullName: 'Rey Koxha',
      email: 'rey@example.test',
      phone: null,
      role: null,
      clientId: CLIENT_ID,
    });
    m.tx.clientContact.update.mockResolvedValue({});

    await expect(
      updateContactAction({
        contactId: CONTACT_ID,
        clientId: CLIENT_ID,
        fullName: 'Rey Koxha',
        email: 'REY@example.test',
        phone: null,
        role: null,
      }),
    ).resolves.toEqual({ ok: true });
    expect(m.revokeAllSessions).not.toHaveBeenCalled();
    expect(m.tx.clientContact.update).toHaveBeenCalledWith({
      where: { id: CONTACT_ID },
      data: {
        fullName: 'Rey Koxha',
        email: 'rey@example.test',
        phone: null,
        role: null,
      },
    });
  });
});
