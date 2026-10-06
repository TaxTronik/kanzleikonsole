// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, GWG-RISK-REVIEW-001,
// GWG-REVERIFICATION-VALIDITY-001
// =============================================================================
// K-01: Lebenszyklus der GwG-Prüfung mit Tx-Signatur (vormals Web:
// server/gwg/reverification.ts und check-mutation.ts). Tx-Attrappe; die
// PostgreSQL-Nachweise (Advisory-Lock, CAS) liegen in
// apps/web/src/server/gwg/__tests__/services-db.test.ts.
// =============================================================================

import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  assertGwgEditable,
  claimCheckMutation,
  confirmUnchangedCheck,
  GWG_CHECK_NOT_EDITABLE_MESSAGE,
  GWG_CHECK_NOT_FOUND_MESSAGE,
  GWG_CHECK_STATUS_CHANGED_MESSAGE,
  GwgCheckRuleError,
  lockGwgCheckLifecycleTx,
  withLockedEditableGwgCheckTx,
} from '../check-lifecycle';

const SCOPE = { tenantId: 'tenant-1', clientId: 'client-1' };

function fakeTx(check: unknown, claimCount = 1) {
  const calls: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:${String(values[0])}`);
      void strings;
      return 0;
    }),
    gwgCheck: {
      findFirst: vi.fn(async () => {
        calls.push('findFirst');
        return check;
      }),
      updateMany: vi.fn(async () => {
        calls.push('updateMany');
        return { count: claimCount };
      }),
    },
  };
  return { tx: tx as unknown as TxClient & typeof tx, calls };
}

async function ruleError(promise: Promise<unknown>): Promise<GwgCheckRuleError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GwgCheckRuleError);
  return error as GwgCheckRuleError;
}

describe('lockGwgCheckLifecycleTx', () => {
  it('nimmt den Advisory-Lock je Tx und Mandant genau einmal', async () => {
    const { tx, calls } = fakeTx(null);
    await Promise.all([lockGwgCheckLifecycleTx(tx, SCOPE), lockGwgCheckLifecycleTx(tx, SCOPE)]);
    await lockGwgCheckLifecycleTx(tx, { ...SCOPE, clientId: 'client-2' });
    expect(calls).toEqual([
      'lock:gwg-check-lifecycle:tenant-1:client-1',
      'lock:gwg-check-lifecycle:tenant-1:client-2',
    ]);
    const other = fakeTx(null);
    await lockGwgCheckLifecycleTx(other.tx, SCOPE);
    expect(other.calls).toEqual(['lock:gwg-check-lifecycle:tenant-1:client-1']);
  });

  it('behandelt einen fehlgeschlagenen Versuch nicht als gehaltenen Lock', async () => {
    const { tx } = fakeTx(null);
    tx.$executeRaw.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(lockGwgCheckLifecycleTx(tx, SCOPE)).rejects.toThrow('lock timeout');
    await lockGwgCheckLifecycleTx(tx, SCOPE);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
});

describe('Bearbeitbarkeit und Status-Claim (§ 8 GwG)', () => {
  it('lässt nur DRAFT und IN_REVIEW zu', () => {
    expect(() => assertGwgEditable('DRAFT')).not.toThrow();
    expect(() => assertGwgEditable('IN_REVIEW')).not.toThrow();
    for (const status of ['VERIFIED', 'REJECTED', 'EXPIRED']) {
      expect(() => assertGwgEditable(status)).toThrow(GWG_CHECK_NOT_EDITABLE_MESSAGE);
    }
  });

  it('setzt eine laufende Freigabe per Status-CAS zurück, optional samt Risikobewertung', async () => {
    const { tx } = fakeTx(null);
    await claimCheckMutation(tx, {
      checkId: 'check-1',
      clientId: 'client-1',
      expectedStatus: 'IN_REVIEW',
    });
    await claimCheckMutation(tx, {
      checkId: 'check-1',
      clientId: 'client-1',
      expectedStatus: 'DRAFT',
      invalidateRisk: true,
    });
    expect(tx.gwgCheck.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'check-1', clientId: 'client-1', status: 'IN_REVIEW' },
          data: { status: 'DRAFT', reviewSubmittedAt: null, reviewSubmittedBy: null },
        },
      ],
      [
        {
          where: { id: 'check-1', clientId: 'client-1', status: 'DRAFT' },
          data: {
            status: 'DRAFT',
            reviewSubmittedAt: null,
            reviewSubmittedBy: null,
            riskLevel: null,
            riskScore: null,
            riskAnswers: Prisma.DbNull,
            riskBreakdown: Prisma.DbNull,
          },
        },
      ],
    ]);
  });

  it('meldet einen parallelen Statuswechsel bei Claim und No-op-CAS', async () => {
    const lost = fakeTx(null, 0);
    const claim = await ruleError(
      claimCheckMutation(lost.tx, { checkId: 'c', clientId: 'k', expectedStatus: 'DRAFT' }),
    );
    expect(claim).toMatchObject({
      code: 'STATUS_CHANGED',
      message: GWG_CHECK_STATUS_CHANGED_MESSAGE,
    });

    const gone = fakeTx(null);
    const noop = await ruleError(
      confirmUnchangedCheck(gone.tx, { checkId: 'c', clientId: 'k', expectedStatus: 'DRAFT' }),
    );
    expect(noop).toMatchObject({
      code: 'STATUS_CHANGED',
      message: GWG_CHECK_STATUS_CHANGED_MESSAGE,
    });
    expect(gone.tx.gwgCheck.findFirst).toHaveBeenCalledWith({
      where: { id: 'c', clientId: 'k', status: 'DRAFT' },
      select: { id: true },
    });
  });
});

describe('withLockedEditableGwgCheckTx', () => {
  const input = { ...SCOPE, checkId: 'check-1', select: { status: true } as const };

  it('lockt vor dem Laden, bindet die Prüfung an den Mandanten und übergibt den Claim', async () => {
    const { tx, calls } = fakeTx({ status: 'IN_REVIEW' });
    const result = await withLockedEditableGwgCheckTx(tx, input, async (check, mutation) => {
      calls.push(`operation:${check.status}`);
      expect(mutation.expectedStatus).toBe('IN_REVIEW');
      await mutation.claim({ invalidateRisk: true });
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toEqual([
      'lock:gwg-check-lifecycle:tenant-1:client-1',
      'findFirst',
      'operation:IN_REVIEW',
      'updateMany',
    ]);
    expect(tx.gwgCheck.findFirst).toHaveBeenCalledWith({
      where: { id: 'check-1', clientId: 'client-1' },
      select: { status: true },
    });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { id: 'check-1', clientId: 'client-1', status: 'IN_REVIEW' },
      data: expect.objectContaining({ status: 'DRAFT', riskAnswers: Prisma.DbNull }),
    });
  });

  it('weist eine fremde oder fehlende Prüfung ab, ohne die Operation auszuführen', async () => {
    const { tx } = fakeTx(null);
    const operation = vi.fn();
    const error = await ruleError(withLockedEditableGwgCheckTx(tx, input, operation));
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: GWG_CHECK_NOT_FOUND_MESSAGE });
    expect(operation).not.toHaveBeenCalled();
  });

  it('prüft eine fachliche Vorbedingung vor der Bearbeitbarkeit', async () => {
    const closed = fakeTx({ status: 'VERIFIED' });
    const precondition = new Error('Nur bei Rechtsträgern.');
    await expect(
      withLockedEditableGwgCheckTx(
        closed.tx,
        {
          ...input,
          beforeEditable: () => {
            throw precondition;
          },
        },
        vi.fn(),
      ),
    ).rejects.toBe(precondition);

    const error = await ruleError(withLockedEditableGwgCheckTx(closed.tx, input, vi.fn()));
    expect(error).toMatchObject({ code: 'NOT_EDITABLE', message: GWG_CHECK_NOT_EDITABLE_MESSAGE });
    expect(closed.tx.gwgCheck.updateMany).not.toHaveBeenCalled();
  });

  it('gibt Fehler der Operation unverändert weiter', async () => {
    const { tx } = fakeTx({ status: 'DRAFT' });
    const failure = new Error('Fachfehler der Operation');
    await expect(
      withLockedEditableGwgCheckTx(tx, input, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
