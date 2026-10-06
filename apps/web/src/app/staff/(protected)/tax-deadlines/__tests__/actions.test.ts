import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNEXPECTED_ACTION_ERROR } from '@/server/actions/to-action-error';

// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001, TAX-CONTROL-STATUS-001

const h = vi.hoisted(() => {
  return {
    currentTx: null as unknown,
    withStaff: vi.fn(),
    staffActionGuard: vi.fn(),
    assertClientAccessTx: vi.fn(),
    resolveNotificationsTx: vi.fn(),
    evidenceRecord: vi.fn(),
    enqueueMaterialize: vi.fn(),
    redirect: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolveNotificationsTx,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/jobs/tax-deadline-materialize-queue', () => ({
  enqueueTaxDeadlineMaterialize: h.enqueueMaterialize,
}));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: h.assertClientAccessTx,
}));
vi.mock('@/server/actions/staff-action', async () => ({
  ActionError: (await import('@/server/actions/action-error')).ActionError,
  staffActionGuard: h.staffActionGuard,
  withStaffModule: () => h.withStaff,
}));

import {
  markDeadlineDoneAction,
  markDeadlinesDoneAction,
  rematerializeAction,
  suppressAutoRequestAction,
  suppressDeadlinesAction,
  unsuppressAutoRequestAction,
} from '../actions';

const DEADLINE_1 = '11111111-1111-4111-8111-111111111111';
const DEADLINE_2 = '22222222-2222-4222-8222-222222222222';

function formWithIds(...ids: string[]): FormData {
  const form = new FormData();
  for (const id of ids) form.append('ids', id);
  return form;
}

describe('Steuertermin-Actions — atomare Lifecycle-Claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withStaff.mockImplementation(
      async (fn: (tx: unknown, context: unknown) => Promise<unknown>) => {
        try {
          const data = await fn(h.currentTx, {
            tenantId: 'tenant-1',
            staffId: 'staff-1',
            session: {},
          });
          return { ok: true, ...(data ?? {}) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'Fehler.' };
        }
      },
    );
    h.assertClientAccessTx.mockResolvedValue(undefined);
    h.resolveNotificationsTx.mockResolvedValue(1);
    h.evidenceRecord.mockResolvedValue(undefined);
  });

  it.each(['OPEN', 'IN_PROGRESS'])(
    'blockiert DONE bei weiterhin %s-er Auto-Anforderung',
    async (status) => {
      const tx = {
        taxDeadline: {
          findUnique: vi.fn().mockResolvedValue({
            status: 'REMINDED',
            clientId: 'client-1',
            request: { status },
          }),
          updateMany: vi.fn(),
        },
      };
      h.currentTx = tx;
      const form = new FormData();
      form.set('id', DEADLINE_1);

      // Review-Befund F-01: die Regel kommt als Ergebnis an (vorher verworfen).
      await expect(markDeadlineDoneAction(null, form)).resolves.toEqual({
        ok: false,
        error: 'Die offene Mandantenanforderung muss vor dem Erledigen abgeschlossen werden.',
      });

      expect(tx.taxDeadline.updateMany).not.toHaveBeenCalled();
      expect(h.resolveNotificationsTx).not.toHaveBeenCalled();
      expect(h.evidenceRecord).not.toHaveBeenCalled();
    },
  );

  it('verliert den DONE-CAS fail-closed, wenn die Anforderung nach dem Read wieder geöffnet wurde', async () => {
    const tx = {
      taxDeadline: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'OVERDUE',
          clientId: 'client-1',
          request: { status: 'CLOSED' },
        }),
        // Simuliert: Relation ist beim atomaren UPDATE inzwischen wieder OPEN.
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    h.currentTx = tx;
    const form = new FormData();
    form.set('id', DEADLINE_1);

    await markDeadlineDoneAction(null, form);

    expect(tx.taxDeadline.updateMany).toHaveBeenCalledWith({
      where: {
        id: DEADLINE_1,
        status: 'OVERDUE',
        OR: [{ requestId: null }, { request: { status: { notIn: ['OPEN', 'IN_PROGRESS'] } } }],
      },
      data: {
        status: 'DONE',
        completedAt: expect.any(Date),
        completedByStaff: 'staff-1',
      },
    });
    expect(h.resolveNotificationsTx).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });

  it('verarbeitet im DONE-Bulk nur die tatsächlich per Zeilen-CAS gewonnene ID weiter', async () => {
    const first = { id: DEADLINE_1, status: 'PLANNED', clientId: 'client-1', request: null };
    const second = { id: DEADLINE_2, status: 'OVERDUE', clientId: 'client-1', request: null };
    const tx = {
      taxDeadline: {
        findMany: vi.fn().mockResolvedValue([first, second]),
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          // Paralleler Aufruf hat DEADLINE_2 bereits verändert.
          .mockResolvedValueOnce({ count: 0 }),
      },
    };
    h.currentTx = tx;

    await markDeadlinesDoneAction(null, formWithIds(DEADLINE_1, DEADLINE_2));

    expect(tx.taxDeadline.updateMany).toHaveBeenCalledTimes(2);
    expect(h.resolveNotificationsTx).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      resources: [{ resourceType: 'tax_deadline', resourceId: DEADLINE_1 }],
    });
    expect(h.evidenceRecord).toHaveBeenCalledOnce();
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        resourceId: DEADLINE_1,
        before: { status: 'PLANNED' },
        after: { status: 'DONE' },
      }),
    );
  });

  it('verarbeitet im Stopp-Bulk nur die tatsächlich per Zeilen-CAS gewonnene ID weiter', async () => {
    const first = { id: DEADLINE_1, clientId: 'client-1', kind: 'USTVA', period: '2026-06' };
    const second = { id: DEADLINE_2, clientId: 'client-1', kind: 'LST', period: '2026-06' };
    const tx = {
      taxDeadline: {
        findMany: vi.fn().mockResolvedValue([first, second]),
        updateMany: vi
          .fn()
          // Materialisierer hat DEADLINE_1 bereits versendet.
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    };
    h.currentTx = tx;

    await suppressDeadlinesAction(null, formWithIds(DEADLINE_1, DEADLINE_2));

    expect(tx.taxDeadline.updateMany).toHaveBeenCalledTimes(2);
    expect(h.resolveNotificationsTx).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      resources: [{ resourceType: 'tax_deadline', resourceId: DEADLINE_2 }],
    });
    expect(h.evidenceRecord).toHaveBeenCalledOnce();
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'tax_deadline.request_suppressed',
        resourceId: DEADLINE_2,
      }),
    );
  });

  it('auditiert kein Entsperren, wenn sich der Suppression-Snapshot parallel geändert hat', async () => {
    const suppressedAt = new Date('2026-08-23T10:00:00.000Z');
    const tx = {
      taxDeadline: {
        findUnique: vi.fn().mockResolvedValue({
          clientId: 'client-1',
          kind: 'USTVA',
          period: '2026-06',
          autoRequestSuppressedAt: suppressedAt,
          autoRequestSuppressedByStaff: 'staff-old',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    h.currentTx = tx;
    const form = new FormData();
    form.set('id', DEADLINE_1);

    await unsuppressAutoRequestAction(null, form);

    expect(tx.taxDeadline.updateMany).toHaveBeenCalledWith({
      where: {
        id: DEADLINE_1,
        autoRequestSuppressedAt: suppressedAt,
        autoRequestSuppressedByStaff: 'staff-old',
      },
      data: { autoRequestSuppressedAt: null, autoRequestSuppressedByStaff: null },
    });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('Steuertermin-Actions — Rückkanal (Review-Befund F-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['markDeadlineDoneAction', markDeadlineDoneAction],
    ['suppressAutoRequestAction', suppressAutoRequestAction],
    ['unsuppressAutoRequestAction', unsuppressAutoRequestAction],
  ] as const)('%s meldet eine ungültige Termin-ID statt zu werfen', async (_name, action) => {
    const form = new FormData();
    form.set('id', 'keine-uuid');

    await expect(action(null, form)).resolves.toEqual({
      ok: false,
      error: 'Ungültige Termin-ID.',
    });
    expect(h.withStaff).not.toHaveBeenCalled();
  });

  it.each([
    ['markDeadlinesDoneAction', markDeadlinesDoneAction],
    ['suppressDeadlinesAction', suppressDeadlinesAction],
  ] as const)('%s meldet eine leere Auswahl, statt still nichts zu tun', async (_name, action) => {
    await expect(action(null, formWithIds())).resolves.toEqual({
      ok: false,
      error: 'Bitte mindestens einen Termin auswählen.',
    });
    expect(h.withStaff).not.toHaveBeenCalled();
  });

  it('gibt die Ablehnung des Wrappers weiter, statt sie zu verwerfen', async () => {
    h.withStaff.mockResolvedValue({ ok: false, error: 'Das Modul ist deaktiviert.' });
    const form = new FormData();
    form.set('id', DEADLINE_1);

    await expect(markDeadlineDoneAction(null, form)).resolves.toEqual({
      ok: false,
      error: 'Das Modul ist deaktiviert.',
    });
    await expect(suppressDeadlinesAction(null, formWithIds(DEADLINE_1))).resolves.toEqual({
      ok: false,
      error: 'Das Modul ist deaktiviert.',
    });
  });

  it('meldet einen unbekannten Termin beim Aufheben des Stopps', async () => {
    h.withStaff.mockImplementation(
      async (fn: (tx: unknown, context: unknown) => Promise<unknown>) => {
        try {
          await fn(
            { taxDeadline: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn() } },
            { tenantId: 'tenant-1', staffId: 'staff-1', session: {} },
          );
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'Fehler.' };
        }
      },
    );
    const form = new FormData();
    form.set('id', DEADLINE_1);

    await expect(unsuppressAutoRequestAction(null, form)).resolves.toEqual({
      ok: false,
      error: 'Termin nicht gefunden.',
    });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });

  it('meldet die Ablehnung des Gates beim Neuberechnen, ohne einen Job einzureihen', async () => {
    h.staffActionGuard.mockResolvedValue({ ok: false, error: 'Nicht eingeloggt.' });

    await expect(rematerializeAction(null, new FormData())).resolves.toEqual({
      ok: false,
      error: 'Nicht eingeloggt.',
    });
    expect(h.enqueueMaterialize).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('meldet eine nicht erreichbare Job-Queue statt einer Fehlerseite', async () => {
    h.staffActionGuard.mockResolvedValue({ ok: true, tenantId: 'tenant-1' });
    h.enqueueMaterialize.mockRejectedValue(new Error('Redis nicht erreichbar.'));

    await expect(rematerializeAction(null, new FormData())).resolves.toEqual({
      ok: false,
      // F-03: Infrastrukturfehler erreichen das UI nur generisch (Original im Log).
      error: UNEXPECTED_ACTION_ERROR,
    });
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
