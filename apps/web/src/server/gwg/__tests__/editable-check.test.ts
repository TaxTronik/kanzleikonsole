// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, GWG-RISK-REVIEW-001
// =============================================================================
// K-01/K-03: Web-Adapter des GwG-Prelude. Der Kern liegt in @taxtronik/gwg;
// hier wird nur geprüft, dass der Mandantenzugriff vor dem Lifecycle-Lock
// steht und fachliche Ablehnungen des Pakets als ActionError mit
// unveränderter Meldung ankommen (toActionError reicht nur diese durch).
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { GwgCheckRuleError } from '@taxtronik/gwg/check-lifecycle';

const access = vi.hoisted(() => ({ assertClientAccessTx: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: access.assertClientAccessTx }));

import { ActionError } from '@/server/actions/action-error';
import { toActionError } from '@/server/actions/to-action-error';
import type { StaffSession } from '@/server/auth/staff';
import {
  assertGwgEditable,
  claimCheckMutation,
  confirmUnchangedCheck,
  gwgCheckActionError,
} from '../check-mutation';
import { withEditableGwgCheckTx } from '../editable-check';

const NOT_EDITABLE =
  'Diese GwG-Prüfung ist bereits abgeschlossen (verifiziert/abgelehnt/abgelaufen) und darf nicht mehr geändert werden (§ 8 GwG). Für eine Aktualisierung bitte eine neue Prüfung anlegen.';
const STATUS_CHANGED =
  'Der Prüfstatus wurde parallel geändert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.';
const session = {} as StaffSession;
const actor = { tenantId: 'tenant-1', session };

function fakeTx(check: unknown, events: string[] = []) {
  return {
    $executeRaw: vi.fn(async () => {
      events.push('lock');
      return 0;
    }),
    gwgCheck: {
      findFirst: vi.fn(async () => {
        events.push('findFirst');
        return check;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  } as unknown as TxClient;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('Web-Adapter check-mutation', () => {
  it('übersetzt fachliche Ablehnungen in ActionErrors mit unveränderter Meldung', async () => {
    expect(() => assertGwgEditable('VERIFIED')).toThrow(new ActionError(NOT_EDITABLE));
    const claim = await rejection(
      claimCheckMutation(fakeTx(null), { checkId: 'c', clientId: 'k', expectedStatus: 'DRAFT' }),
    );
    expect(claim).toBeInstanceOf(ActionError);
    expect(toActionError(claim)).toEqual({ ok: false, error: STATUS_CHANGED });
    const unchanged = await rejection(
      confirmUnchangedCheck(fakeTx(null), { checkId: 'c', clientId: 'k', expectedStatus: 'DRAFT' }),
    );
    expect(unchanged).toEqual(new ActionError(STATUS_CHANGED));
  });

  it('lässt andere Fehler unverändert durch', () => {
    const failure = new Error('Datenbank nicht erreichbar');
    expect(gwgCheckActionError(failure)).toBe(failure);
    expect(
      gwgCheckActionError(new GwgCheckRuleError('NOT_FOUND', 'GwG-Check nicht gefunden.')),
    ).toEqual(new ActionError('GwG-Check nicht gefunden.'));
  });
});

describe('withEditableGwgCheckTx', () => {
  it('prüft den Mandantenzugriff vor Lock und Snapshot', async () => {
    const events: string[] = [];
    access.assertClientAccessTx.mockImplementationOnce(async () => {
      events.push('access');
    });
    const tx = fakeTx({ status: 'DRAFT' }, events);
    await withEditableGwgCheckTx(
      tx,
      actor,
      { clientId: 'client-1', checkId: 'check-1', select: { status: true } },
      async () => {
        events.push('operation');
      },
    );
    expect(access.assertClientAccessTx).toHaveBeenCalledWith(tx, session, 'client-1');
    expect(events).toEqual(['access', 'lock', 'findFirst', 'operation']);
  });

  it('lehnt ohne Mandantenzugriff ab, bevor gelockt wird', async () => {
    const forbidden = new Error('Kein Zugriff auf diesen Mandanten.');
    access.assertClientAccessTx.mockRejectedValueOnce(forbidden);
    const tx = fakeTx({ status: 'DRAFT' });
    await expect(
      withEditableGwgCheckTx(
        tx,
        actor,
        { clientId: 'k', checkId: 'c', select: { status: true } },
        vi.fn(),
      ),
    ).rejects.toBe(forbidden);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('meldet fehlende und abgeschlossene Prüfungen als ActionError', async () => {
    const input = { clientId: 'k', checkId: 'c', select: { status: true } as const };
    expect(await rejection(withEditableGwgCheckTx(fakeTx(null), actor, input, vi.fn()))).toEqual(
      new ActionError('GwG-Check nicht gefunden.'),
    );
    expect(
      await rejection(withEditableGwgCheckTx(fakeTx({ status: 'EXPIRED' }), actor, input, vi.fn())),
    ).toEqual(new ActionError(NOT_EDITABLE));
    const claim = await rejection(
      withEditableGwgCheckTx(fakeTx({ status: 'DRAFT' }), actor, input, (_check, mutation) =>
        mutation.claim(),
      ),
    );
    expect(claim).toEqual(new ActionError(STATUS_CHANGED));
  });

  it('gibt Fehler der Operation und der Vorbedingung unverändert weiter', async () => {
    const input = { clientId: 'k', checkId: 'c', select: { status: true } as const };
    const failure = new ActionError('Doppelrollen sind nur bei Rechtsträgern vorgesehen.');
    await expect(
      withEditableGwgCheckTx(
        fakeTx({ status: 'VERIFIED' }),
        actor,
        {
          ...input,
          beforeEditable: () => {
            throw failure;
          },
        },
        vi.fn(),
      ),
    ).rejects.toBe(failure);
    await expect(
      withEditableGwgCheckTx(fakeTx({ status: 'DRAFT' }), actor, input, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
