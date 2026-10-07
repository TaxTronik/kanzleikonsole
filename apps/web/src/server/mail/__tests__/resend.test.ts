// Review-Entscheidung C4: „Erneut senden" an den Zustellstatus-Zeilen.
// Gate je Anlass wie die auslösende Action, Mandantenzugriff, Bestätigung bei
// unklarem Ausgang, dieselbe Zustandsprüfung wie der Worker, Rücksetzen nur
// über app.mail_outbox_resend und Audit im selben Commit.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  assertClientAccessTx: vi.fn(),
  canStaffReviewGwgTx: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: h.assertClientAccessTx }));
vi.mock('@/server/gwg/professional-review', () => ({
  canStaffReviewGwgTx: h.canStaffReviewGwgTx,
}));
vi.mock('@/server/actions/audit', () => ({ audit: h.audit }));

import type { TxClient } from '@taxtronik/db';
import { MAIL_OUTBOX_PURPOSES, type MailOutboxPurpose } from '@taxtronik/mail/outbox';
import { ActionError } from '@/server/actions/action-error';
import { MAIL_RESEND_GUARDS, resendMailOutboxTx, type MailResendInput } from '../resend';

const NOW = new Date('2026-10-07T10:00:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const INVOICE = '33333333-3333-4333-8333-333333333333';
const OUTBOX_A = '44444444-4444-4444-8444-444444444444';
const OUTBOX_B = '55555555-5555-4555-8555-555555555555';
const STAFF = '66666666-6666-4666-8666-666666666666';

const actor = {
  session: { user: { tenantId: TENANT, staffId: STAFF } },
  tenantId: TENANT,
  staffId: STAFF,
  ctx: { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' as const },
} as unknown as Parameters<typeof resendMailOutboxTx>[1];

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OUTBOX_A,
    tenantId: TENANT,
    clientId: CLIENT,
    purpose: 'invoice-sent',
    resourceType: 'invoice',
    resourceId: INVOICE,
    status: 'FAILED',
    attemptCount: 6,
    ...overrides,
  };
}

function input(overrides: Partial<MailResendInput> = {}): MailResendInput {
  return {
    purpose: 'invoice-sent',
    resourceType: 'invoice',
    resourceId: INVOICE,
    outboxIds: [OUTBOX_A],
    confirmUncertain: false,
    ...overrides,
  };
}

function txWith(rows: ReturnType<typeof outboxRow>[]) {
  const queryRaw = vi.fn().mockResolvedValue([{ ok: true }]);
  const tx = {
    mailOutbox: { findMany: vi.fn().mockResolvedValue(rows) },
    $queryRaw: queryRaw,
    client: { findFirst: vi.fn().mockResolvedValue({ anonymizedAt: null }) },
    invoice: { findFirst: vi.fn().mockResolvedValue({ status: 'SENT', sentAt: NOW }) },
    gwgCheck: {
      findFirst: vi.fn().mockResolvedValue({ status: 'VERIFIED', client: { allowActive: true } }),
    },
  };
  return { tx: tx as unknown as TxClient, raw: tx, queryRaw };
}

/** Parameter eines app.mail_outbox_resend-Aufrufs (Tagged Template: Werte ab Index 1). */
function resendCall(queryRaw: ReturnType<typeof vi.fn>, index = 0) {
  const [strings, ...values] = queryRaw.mock.calls[index]!;
  return { sql: (strings as string[]).join('?'), values };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assertClientAccessTx.mockResolvedValue(undefined);
  h.canStaffReviewGwgTx.mockResolvedValue(true);
  h.audit.mockResolvedValue(undefined);
});

describe('MAIL_RESEND_GUARDS', () => {
  it('nennt für jeden Anlass das Gate der auslösenden Action', () => {
    expect(Object.keys(MAIL_RESEND_GUARDS).sort()).toEqual([...MAIL_OUTBOX_PURPOSES].sort());
    expect(MAIL_RESEND_GUARDS['invoice-sent']).toEqual({
      requirePermission: 'INVOICE_SEND',
      modeModule: 'invoices',
    });
    expect(MAIL_RESEND_GUARDS['invoice-external']).toEqual({
      requirePermission: 'INVOICE_SEND',
      modeModule: 'invoices',
    });
    expect(MAIL_RESEND_GUARDS['handover-ready']).toEqual({ module: 'handovers' });
    expect(MAIL_RESEND_GUARDS['appointment-confirmed']).toEqual({ module: 'appointments' });
    expect(MAIL_RESEND_GUARDS['appointment-rejected']).toEqual({ module: 'appointments' });
    expect(MAIL_RESEND_GUARDS['form-sent']).toEqual({ module: 'forms' });
    for (const purpose of [
      'request-opened',
      'request-staff-replied',
      'gwg-invite',
      'gwg-activated',
    ] satisfies MailOutboxPurpose[]) {
      expect(MAIL_RESEND_GUARDS[purpose]).toEqual({});
    }
  });
});

describe('resendMailOutboxTx', () => {
  it('setzt fehlgeschlagene Aufträge über die DB-Funktion zurück und auditiert jeden', async () => {
    const { tx, raw, queryRaw } = txWith([
      outboxRow(),
      outboxRow({ id: OUTBOX_B, attemptCount: 6 }),
    ]);

    const outcome = await resendMailOutboxTx(
      tx,
      actor,
      input({ outboxIds: [OUTBOX_A, OUTBOX_B] }),
      NOW,
    );

    expect(outcome).toEqual({ kind: 'requeued', count: 2 });
    expect(raw.mailOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: [OUTBOX_A, OUTBOX_B] },
          tenantId: TENANT,
          purpose: 'invoice-sent',
          resourceType: 'invoice',
          resourceId: INVOICE,
        },
      }),
    );
    expect(h.assertClientAccessTx).toHaveBeenCalledWith(tx, actor.session, CLIENT);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const first = resendCall(queryRaw);
    expect(first.sql).toContain('app.mail_outbox_resend(');
    expect(first.values).toEqual([OUTBOX_A, 'FAILED', null]);
    expect(h.audit).toHaveBeenCalledWith(tx, actor, {
      action: 'mail_outbox.resend',
      resourceType: 'mail_outbox',
      resourceId: OUTBOX_A,
      before: {
        status: 'FAILED',
        attemptCount: 6,
        purpose: 'invoice-sent',
        resourceType: 'invoice',
        resourceId: INVOICE,
      },
      after: { status: 'QUEUED' },
    });
    expect(h.audit).toHaveBeenCalledTimes(2);
  });

  it('verlangt bei unklarem Ausgang eine ausdrückliche Bestätigung', async () => {
    const { tx, queryRaw } = txWith([outboxRow({ status: 'UNKNOWN', attemptCount: 1 })]);

    await expect(resendMailOutboxTx(tx, actor, input(), NOW)).rejects.toThrow(
      'möglicherweise bereits zugestellt',
    );
    expect(queryRaw).not.toHaveBeenCalled();

    await expect(
      resendMailOutboxTx(tx, actor, input({ confirmUncertain: true }), NOW),
    ).resolves.toEqual({ kind: 'requeued', count: 1 });
    expect(resendCall(queryRaw).values).toEqual([OUTBOX_A, 'UNKNOWN', null]);
  });

  it('verwirft den Auftrag mit Begründung, wenn der Vorgang nicht mehr aktuell ist', async () => {
    const { tx, raw, queryRaw } = txWith([outboxRow()]);
    raw.invoice.findFirst.mockResolvedValue(null);

    const outcome = await resendMailOutboxTx(tx, actor, input(), NOW);

    expect(outcome).toEqual({
      kind: 'skipped',
      count: 1,
      reason: 'Die Rechnung existiert nicht mehr.',
    });
    expect(resendCall(queryRaw).values).toEqual([
      OUTBOX_A,
      'FAILED',
      'Die Rechnung existiert nicht mehr.',
    ]);
    expect(h.audit).toHaveBeenCalledWith(
      tx,
      actor,
      expect.objectContaining({
        action: 'mail_outbox.resend_skipped',
        after: { status: 'SKIPPED', reason: 'Die Rechnung existiert nicht mehr.' },
      }),
    );
  });

  it('prüft den Mandantenzugriff vor jedem Rücksetzen', async () => {
    const { tx, queryRaw } = txWith([outboxRow()]);
    h.assertClientAccessTx.mockRejectedValue(new ActionError('Kein Zugriff auf diesen Mandanten.'));

    await expect(resendMailOutboxTx(tx, actor, input(), NOW)).rejects.toThrow(
      'Kein Zugriff auf diesen Mandanten.',
    );
    expect(queryRaw).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('lässt die GwG-Begrüßungsmail nur durch den zugeordneten Berufsträger erneut senden', async () => {
    const gwgRow = outboxRow({
      purpose: 'gwg-activated',
      resourceType: 'gwg_check',
      resourceId: INVOICE,
    });
    const { tx, queryRaw } = txWith([gwgRow]);
    h.canStaffReviewGwgTx.mockResolvedValue(false);
    const gwgInput = input({ purpose: 'gwg-activated', resourceType: 'gwg_check' });

    await expect(resendMailOutboxTx(tx, actor, gwgInput, NOW)).rejects.toThrow('Berufsträger');
    expect(h.canStaffReviewGwgTx).toHaveBeenCalledWith(tx, {
      tenantId: TENANT,
      clientId: CLIENT,
      staffId: STAFF,
    });
    expect(queryRaw).not.toHaveBeenCalled();

    h.canStaffReviewGwgTx.mockResolvedValue(true);
    await expect(resendMailOutboxTx(tx, actor, gwgInput, NOW)).resolves.toEqual({
      kind: 'requeued',
      count: 1,
    });
  });

  it.each([
    ['einen fremden oder unbekannten Auftrag', [], 'nicht gefunden'],
    ['einen bereits zugestellten Auftrag', [outboxRow({ status: 'PROVIDER_ACCEPTED' })], 'Nur'],
    ['einen wartenden Auftrag', [outboxRow({ status: 'RETRY_PENDING' })], 'Nur'],
  ])('lehnt %s ab', async (_label, rows, message) => {
    const { tx, queryRaw } = txWith(rows);

    await expect(resendMailOutboxTx(tx, actor, input(), NOW)).rejects.toThrow(message);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('rollt zurück, wenn die DB-Funktion den Übergang verweigert', async () => {
    const { tx, queryRaw } = txWith([outboxRow()]);
    queryRaw.mockResolvedValue([{ ok: false }]);

    await expect(resendMailOutboxTx(tx, actor, input(), NOW)).rejects.toThrow(
      'Inhalt wurde nach Ablauf der Aufbewahrung entfernt',
    );
    expect(h.audit).not.toHaveBeenCalled();
  });
});
