// Review-Finding P-18: Bulk-Kern der Dokumentenverwaltung — eine Transaktion je
// Auswahl, Zugriff und Audit je Eintrag, Einzel-Rückfall nur bei Datenbankfehlern.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  class ForbiddenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ForbiddenError';
    }
  }
  return {
    ActionError,
    ForbiddenError,
    transactions: [] as Array<{ tx: number }>,
    failTransaction: null as null | ((tx: number) => boolean),
    assertClientAccessTx: vi.fn(),
    revalidatePath: vi.fn(),
    log: { warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) => {
    const tx = { tx: m.transactions.length + 1 };
    m.transactions.push(tx);
    return run(tx);
  },
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: m.assertClientAccessTx,
  toActionError: (error: unknown) => ({
    ok: false,
    error:
      error instanceof m.ActionError || error instanceof m.ForbiddenError
        ? error.message
        : 'Datenbankfehler.',
  }),
}));
vi.mock('@/server/actions/staff-action', () => ({ ActionError: m.ActionError }));
vi.mock('@/server/logger', () => ({ log: m.log }));

import {
  BULK_NOT_ATTEMPTED,
  BULK_TX_ITEMS,
  bulkActionError,
  bulkActionResult,
  revalidateDocumentLists,
  runDocumentBulk,
} from '../document-bulk';

const staff = {
  tenantId: 'tenant-1',
  staffId: 'staff-1',
  session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
  ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const },
} as unknown as Parameters<typeof runDocumentBulk>[0];

const ids = (...values: string[]) => values.map((id) => ({ id }));

beforeEach(() => {
  vi.clearAllMocks();
  m.transactions.length = 0;
  m.assertClientAccessTx.mockResolvedValue(undefined);
});

describe('runDocumentBulk', () => {
  it('verarbeitet die Auswahl in einer Transaktion, nach ID sortiert und ohne Duplikate', async () => {
    const apply = vi.fn(async (_tx: unknown, item: { id: string }) => `ok:${item.id}`);

    const outcome = await runDocumentBulk(staff, ids('c', 'a', 'b', 'a'), apply, {
      component: 'test',
    });

    expect(m.transactions).toHaveLength(1);
    expect(apply.mock.calls.map(([tx, item]) => [tx, item.id])).toEqual([
      [{ tx: 1 }, 'a'],
      [{ tx: 1 }, 'b'],
      [{ tx: 1 }, 'c'],
    ]);
    expect(outcome).toEqual({
      done: [
        { id: 'a', value: 'ok:a' },
        { id: 'b', value: 'ok:b' },
        { id: 'c', value: 'ok:c' },
      ],
      rejected: [],
    });
  });

  it('sperrt die Zeilen jedes Blocks in derselben Transaktion vor dem ersten Eintrag', async () => {
    const trace: string[] = [];
    const many = Array.from({ length: BULK_TX_ITEMS + 1 }, (_, index) => ({
      id: `doc-${String(index).padStart(4, '0')}`,
    }));

    await runDocumentBulk(
      staff,
      many,
      async (tx, { id }) => {
        trace.push(`apply:${(tx as unknown as { tx: number }).tx}:${id}`);
        return id;
      },
      {
        component: 'test',
        lockBlock: async (tx, block) => {
          trace.push(`lock:${(tx as unknown as { tx: number }).tx}:${block.length}`);
        },
      },
    );

    expect(trace[0]).toBe(`lock:1:${BULK_TX_ITEMS}`);
    expect(trace[1]).toBe('apply:1:doc-0000');
    expect(trace[BULK_TX_ITEMS + 1]).toBe('lock:2:1');
    expect(trace[BULK_TX_ITEMS + 2]).toBe(`apply:2:doc-${String(BULK_TX_ITEMS).padStart(4, '0')}`);
  });

  it('lehnt fachlich einzelne Einträge ab und setzt dieselbe Transaktion fort', async () => {
    const outcome = await runDocumentBulk(
      staff,
      ids('a', 'b', 'c'),
      async (_tx, { id }) => {
        if (id === 'a') throw new m.ActionError('Dokument nicht gefunden.');
        if (id === 'b') throw new m.ForbiddenError('Kein Zugriff auf diesen Mandanten.');
        return id;
      },
      { component: 'test' },
    );

    expect(m.transactions).toHaveLength(1);
    expect(outcome).toEqual({
      done: [{ id: 'c', value: 'c' }],
      rejected: [
        { id: 'a', error: 'Dokument nicht gefunden.' },
        { id: 'b', error: 'Kein Zugriff auf diesen Mandanten.' },
      ],
    });
  });

  it('prüft den Mandantenzugriff je Mandant einmal je Transaktion', async () => {
    m.assertClientAccessTx.mockImplementation(async (_tx, _session, clientId: string) => {
      if (clientId === 'client-geheim') {
        throw new m.ForbiddenError('Kein Zugriff auf diesen Mandanten.');
      }
    });
    const clientOf: Record<string, string> = {
      a: 'client-1',
      b: 'client-1',
      c: 'client-geheim',
      d: 'client-geheim',
    };

    const outcome = await runDocumentBulk(
      staff,
      ids('a', 'b', 'c', 'd'),
      async (_tx, { id }, assertAccess) => {
        await assertAccess(clientOf[id]!);
        return id;
      },
      { component: 'test' },
    );

    expect(m.assertClientAccessTx.mock.calls).toEqual([
      [{ tx: 1 }, staff.session, 'client-1'],
      [{ tx: 1 }, staff.session, 'client-geheim'],
    ]);
    expect(outcome.done.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(outcome.rejected).toEqual([
      { id: 'c', error: 'Kein Zugriff auf diesen Mandanten.' },
      { id: 'd', error: 'Kein Zugriff auf diesen Mandanten.' },
    ]);
  });

  it('wiederholt einen an der Datenbank gescheiterten Block je Eintrag in eigener Transaktion', async () => {
    const triggerError = Object.assign(new Error('payroll archive cannot be shared'), {
      code: 'P2010',
    });
    const apply = vi.fn(async (_tx: unknown, { id }: { id: string }) => {
      if (id === 'b') throw triggerError;
      return id;
    });

    const outcome = await runDocumentBulk(staff, ids('a', 'b', 'c'), apply, {
      component: 'test',
    });

    // Block (zurückgerollt) + je Eintrag eine Transaktion.
    expect(m.transactions).toHaveLength(4);
    expect(outcome).toEqual({
      done: [
        { id: 'a', value: 'a' },
        { id: 'c', value: 'c' },
      ],
      rejected: [{ id: 'b', error: 'Datenbankfehler.' }],
    });
    expect(m.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'test', blockSize: 3, code: 'P2010' }),
      expect.stringContaining('einzeln'),
    );
  });

  it('nutzt im Einzel-Rückfall die normale Zugriffsprüfung und eigene Fehlermeldungen', async () => {
    let firstAttempt = true;
    const outcome = await runDocumentBulk(
      staff,
      ids('a', 'b'),
      async (_tx, { id }, assertAccess) => {
        await assertAccess(`client-${id}`);
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error('deadlock detected');
        }
        if (id === 'b') throw Object.assign(new Error('unique'), { code: 'P2002' });
        return id;
      },
      {
        component: 'test',
        errorMessage: (error) =>
          (error as { code?: string }).code === 'P2002' ? 'Name existiert bereits.' : 'Fehler.',
      },
    );

    expect(outcome).toEqual({
      done: [{ id: 'a', value: 'a' }],
      rejected: [{ id: 'b', error: 'Name existiert bereits.' }],
    });
    expect(m.assertClientAccessTx.mock.calls.map(([tx, , clientId]) => [tx, clientId])).toEqual([
      [{ tx: 1 }, 'client-a'],
      [{ tx: 2 }, 'client-a'],
      [{ tx: 3 }, 'client-b'],
    ]);
  });

  it('bricht nach drei Datenbankfehlern in Folge ab und meldet den Rest als nicht verarbeitet', async () => {
    const outcome = await runDocumentBulk(
      staff,
      ids('a', 'b', 'c', 'd', 'e'),
      async () => {
        throw new Error('connection refused');
      },
      { component: 'test' },
    );

    expect(m.transactions).toHaveLength(1 + 3);
    expect(outcome.done).toEqual([]);
    expect(outcome.rejected).toEqual([
      { id: 'a', error: 'Datenbankfehler.' },
      { id: 'b', error: 'Datenbankfehler.' },
      { id: 'c', error: 'Datenbankfehler.' },
      { id: 'd', error: BULK_NOT_ATTEMPTED },
      { id: 'e', error: BULK_NOT_ATTEMPTED },
    ]);
  });

  it('versucht einen einzelnen Eintrag nach einem Datenbankfehler nicht doppelt', async () => {
    const apply = vi.fn(async () => {
      throw new Error('statement timeout');
    });

    const outcome = await runDocumentBulk(staff, ids('a'), apply, { component: 'test' });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(m.transactions).toHaveLength(1);
    expect(outcome.rejected).toEqual([{ id: 'a', error: 'Datenbankfehler.' }]);
  });

  it(`teilt große Auswahlen in Transaktionen zu je ${BULK_TX_ITEMS} Einträgen`, async () => {
    const many = Array.from({ length: 2 * BULK_TX_ITEMS + 50 }, (_, index) => ({
      id: `doc-${String(index).padStart(4, '0')}`,
    }));
    const seenIn = new Map<string, number>();

    const outcome = await runDocumentBulk(
      staff,
      many,
      async (tx, { id }) => {
        seenIn.set(id, (tx as unknown as { tx: number }).tx);
        return id;
      },
      { component: 'test' },
    );

    expect(m.transactions).toHaveLength(3);
    expect(outcome.done).toHaveLength(many.length);
    expect(seenIn.get('doc-0000')).toBe(1);
    expect(seenIn.get(`doc-${String(BULK_TX_ITEMS).padStart(4, '0')}`)).toBe(2);
  });
});

describe('Bulk-Ergebnis und Revalidierung', () => {
  it('revalidiert die Dokumentliste einmal und jede betroffene Mandantenseite einmal', () => {
    revalidateDocumentLists(['client-1', null, 'client-2', 'client-1', undefined]);

    expect(m.revalidatePath.mock.calls).toEqual([
      ['/staff/documents'],
      ['/staff/clients/client-1'],
      ['/staff/clients/client-2'],
    ]);
  });

  it('meldet Erfolg nur ohne Ablehnungen und ohne offene Einträge', () => {
    expect(bulkActionResult(2, [])).toEqual({ ok: true, done: 2, rejected: [] });
    expect(bulkActionResult(1, [{ id: 'b', error: 'Nein.' }])).toEqual({
      ok: false,
      done: 1,
      rejected: [{ id: 'b', error: 'Nein.' }],
    });
    expect(bulkActionResult(1, [], ['c'])).toEqual({
      ok: false,
      done: 1,
      rejected: [],
      pending: ['c'],
    });
    expect(bulkActionError('Nicht eingeloggt.')).toEqual({
      ok: false,
      done: 0,
      rejected: [],
      error: 'Nicht eingeloggt.',
    });
  });
});
