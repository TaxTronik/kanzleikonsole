// Review-Entscheidung C4: Server-Action „Erneut senden". Eingabeprüfung vor dem
// Gate, Gate je Anlass wie die auslösende Action, Anstoß des Workers nur nach
// einem Rücksetzen (nie SMTP aus dem Request), verworfener Auftrag als
// Konflikt mit Begründung.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  withTenantContext: vi.fn(),
  resend: vi.fn(),
  kick: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/mail/outbox', () => ({ kickMailOutboxDelivery: h.kick }));
vi.mock('@/server/mail/resend', () => ({ resendMailOutboxTx: h.resend }));
vi.mock('@/server/actions/staff-action', async () => {
  const { createActionRunner } = await vi.importActual<
    typeof import('@/server/actions/action-runner')
  >('@/server/actions/action-runner');
  return { staffAction: createActionRunner(h.guard) };
});

import { resendMailOutboxAction } from '../resend-actions';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RESOURCE = '33333333-3333-4333-8333-333333333333';
const OUTBOX = '44444444-4444-4444-8444-444444444444';
const STAFF_CTX = {
  ok: true,
  tenantId: TENANT,
  staffId: 'staff-1',
  session: { user: { tenantId: TENANT } },
  ctx: { tenantId: TENANT, actorId: 'staff-1', actorType: 'STAFF' },
};
const TX = { marker: 'tx' };

function request(overrides: Record<string, unknown> = {}) {
  return {
    purpose: 'invoice-sent',
    resourceType: 'invoice',
    resourceId: RESOURCE,
    outboxIds: [OUTBOX],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue(STAFF_CTX);
  h.withTenantContext.mockImplementation(async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run(TX),
  );
  h.resend.mockResolvedValue({ kind: 'requeued', count: 1 });
});

describe('resendMailOutboxAction', () => {
  it('prüft Anlass und IDs vor dem Gate', async () => {
    for (const bad of [
      request({ purpose: 'unbekannt' }),
      request({ outboxIds: [] }),
      request({ outboxIds: ['keine-uuid'] }),
      request({ resourceType: 'Invoice; DROP' }),
    ]) {
      await expect(resendMailOutboxAction(bad)).resolves.toMatchObject({
        ok: false,
        errorCode: 'VALIDATION_ERROR',
      });
    }
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('wendet das Gate der auslösenden Action an und stößt danach nur den Worker an', async () => {
    const result = await resendMailOutboxAction(request());

    expect(h.guard).toHaveBeenCalledWith({
      requirePermission: 'INVOICE_SEND',
      modeModule: 'invoices',
    });
    expect(h.withTenantContext).toHaveBeenCalledWith(STAFF_CTX.ctx, expect.any(Function));
    expect(h.resend).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ tenantId: TENANT, staffId: 'staff-1' }),
      {
        purpose: 'invoice-sent',
        resourceType: 'invoice',
        resourceId: RESOURCE,
        outboxIds: [OUTBOX],
        confirmUncertain: false,
      },
      expect.any(Date),
    );
    expect(h.kick).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, requeued: 1 });
  });

  it.each([
    ['appointment-confirmed', { module: 'appointments' }],
    ['form-sent', { module: 'forms' }],
    ['handover-ready', { module: 'handovers' }],
    ['gwg-invite', {}],
  ])('nutzt für %s das passende Gate', async (purpose, guard) => {
    await resendMailOutboxAction(request({ purpose }));
    expect(h.guard).toHaveBeenCalledWith(guard);
  });

  it('meldet eine Ablehnung des Gates ohne Rücksetzen', async () => {
    h.guard.mockResolvedValue({ ok: false, error: 'Keine Berechtigung (INVOICE_SEND).' });

    await expect(resendMailOutboxAction(request())).resolves.toEqual({
      ok: false,
      error: 'Keine Berechtigung (INVOICE_SEND).',
    });
    expect(h.resend).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('meldet einen verworfenen Auftrag als Konflikt und stößt nichts an', async () => {
    h.resend.mockResolvedValue({
      kind: 'skipped',
      count: 1,
      reason: 'Die GwG-Einladung wurde zurückgezogen.',
    });

    await expect(resendMailOutboxAction(request({ confirmUncertain: true }))).resolves.toEqual({
      ok: false,
      error: 'Nicht erneut gesendet: Die GwG-Einladung wurde zurückgezogen.',
      errorCode: 'CONFLICT',
    });
    expect(h.kick).not.toHaveBeenCalled();
  });
});
