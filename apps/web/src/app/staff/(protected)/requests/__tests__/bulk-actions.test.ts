import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@taxtronik/db/prisma-client';

const h = vi.hoisted(() => ({
  /** Decides per transaction (by the request IDs it touches) whether it fails. */
  failTx: null as null | ((ids: string[]) => Error | null),
  titleLookupFails: false,
  updated: [] as string[][],
  record: vi.fn(),
  resolve: vi.fn(),
  emit: vi.fn(),
  revalidatePath: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: vi.fn(async () => ({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  })),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      request: {
        findMany: async ({
          where,
          select,
        }: {
          where: { id: { in: string[] } };
          select: Record<string, boolean>;
        }) => {
          if (select['title']) {
            if (h.titleLookupFails) throw new Error('connection terminated');
            return where.id.in.map((id) => ({ id, title: `Anforderung ${id}` }));
          }
          return where.id.in.map((id) => ({ id, status: 'OPEN' }));
        },
        updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          const failure = h.failTx?.(where.id.in) ?? null;
          if (failure) throw failure;
          h.updated.push(where.id.in);
          return { count: where.id.in.length };
        },
      },
    };
    return fn(tx);
  },
}));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: h.resolve }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/logger', () => ({ log: h.log }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: h.emit }));

import { bulkCloseRequestsAction } from '../bulk-actions';

const ids = (count: number, prefix = 'a') =>
  Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(7, '0')}-0000-4000-8000-000000000000`,
  );

function dbError(code: string, sqlState?: string) {
  return new Prisma.PrismaClientKnownRequestError('Database error', {
    code,
    clientVersion: 'test',
    meta: sqlState ? { driverAdapterError: { cause: { originalCode: sqlState } } } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.failTx = null;
  h.titleLookupFails = false;
  h.updated = [];
});

describe('F-05 bulkCloseRequestsAction failure reporting', () => {
  it('closes everything in chunks when nothing fails', async () => {
    const all = ids(30);
    const result = await bulkCloseRequestsAction({ ids: all });

    expect(result).toEqual({ ok: true, affected: 30 });
    expect(h.updated.map((chunk) => chunk.length)).toEqual([25, 5]);
    expect(h.emit).toHaveBeenCalledTimes(30);
  });

  it('closes the rest of a failed chunk and names the request that failed and why', async () => {
    const all = ids(4);
    const poisoned = all[2]!;
    h.failTx = (touched) => (touched.includes(poisoned) ? dbError('P2039', 'P0001') : null);

    const result = await bulkCloseRequestsAction({ ids: all });

    expect(result.ok).toBe(false);
    expect(result.affected).toBe(3);
    expect(result.failed).toEqual([
      {
        id: poisoned,
        title: `Anforderung ${poisoned}`,
        reason:
          'Datenbankregel verhindert das Schließen (z. B. Verknüpfung mit Steuertermin oder Workflow) — bitte einzeln prüfen',
      },
    ]);
    expect(result.error).toBe(
      `Teilweise abgeschlossen: 3 geschlossen, 1 nicht geschlossen — „Anforderung ${poisoned}“ (Datenbankregel verhindert das Schließen (z. B. Verknüpfung mit Steuertermin oder Workflow) — bitte einzeln prüfen).`,
    );
    expect(h.updated).toEqual([[all[0]], [all[1]], [all[3]]]);
    expect(h.emit).toHaveBeenCalledTimes(3);
    expect(h.emit).not.toHaveBeenCalledWith(
      'request.closed',
      { tenantId: 'tenant-1', requestId: poisoned },
      { tenantId: 'tenant-1' },
    );
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: poisoned, code: 'P2039', sqlState: 'P0001' }),
      'bulk-close: Anforderung nicht geschlossen',
    );
  });

  it('stops after repeated failures and reports the untried requests without titles', async () => {
    const all = ids(30);
    h.failTx = () => dbError('P2028');
    h.titleLookupFails = true;

    const result = await bulkCloseRequestsAction({ ids: all });

    expect(result.ok).toBe(false);
    expect(result.affected).toBe(0);
    expect(result.failed).toHaveLength(30);
    expect(result.failed!.slice(0, 3).map((failure) => failure.reason)).toEqual(
      Array(3).fill('Zeitüberschreitung — bitte erneut versuchen'),
    );
    expect(new Set(result.failed!.slice(3).map((failure) => failure.reason))).toEqual(
      new Set(['nicht verarbeitet — Abbruch nach wiederholten Fehlern']),
    );
    expect(result.failed!.every((failure) => failure.title === null)).toBe(true);
    expect(result.error).toContain('0 geschlossen, 30 nicht geschlossen');
    expect(result.error).toContain(`„${all[0]}“ (Zeitüberschreitung — bitte erneut versuchen)`);
    expect(result.error).toContain('und 27 weitere');
    // 1 chunk attempt + 3 single attempts; the second chunk is not tried at all.
    expect(h.log.error).toHaveBeenCalledTimes(3);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'connection terminated' }),
      'bulk-close: Titel der nicht geschlossenen Anforderungen nicht lesbar',
    );
    expect(h.emit).not.toHaveBeenCalled();
  });
});
