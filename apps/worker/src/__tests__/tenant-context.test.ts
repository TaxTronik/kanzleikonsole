// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): systemContextClient ersetzt den Owner-Client in Kernen
// mit eigenem DB-Parameter. Jeder Aufruf läuft in einer eigenen Transaktion im
// SYSTEM-Kontext des Tenants über die App-Rolle (withSystemContext); die
// DB-Suite tax-deadline-materialize-db.test.ts belegt das gegen PostgreSQL.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const tx = {
    taxDeadline: { findMany: vi.fn(async (args: unknown) => [{ args }]) },
    $queryRaw: vi.fn(async () => [{ ok: true }]),
  };
  return {
    tx,
    contexts: [] as string[],
    withSystemContext: vi.fn(async (tenantId: string, fn: (value: typeof tx) => unknown) => {
      h.contexts.push(tenantId);
      return fn(tx);
    }),
  };
});

vi.mock('@taxtronik/db', () => ({ withSystemContext: h.withSystemContext, TX_OPTIONS: {} }));
vi.mock('../prisma-owner', () => ({ prismaOwner: {} }));

import { systemContextClient } from '../tenant-context';

beforeEach(() => {
  h.contexts.length = 0;
  vi.clearAllMocks();
});

describe('systemContextClient', () => {
  it('führt jeden Modellaufruf in einer eigenen Transaktion des Tenants aus', async () => {
    const db = systemContextClient('tenant-1');
    const where = { where: { tenantId: 'tenant-1' } };

    await expect(db.taxDeadline.findMany(where as never)).resolves.toEqual([{ args: where }]);
    await db.taxDeadline.findMany(where as never);

    expect(h.contexts).toEqual(['tenant-1', 'tenant-1']);
    expect(h.tx.taxDeadline.findMany).toHaveBeenCalledTimes(2);
  });

  it('reicht Raw-Abfragen und $transaction(fn) an den Tenant-Kontext durch', async () => {
    const db = systemContextClient('tenant-2');

    await expect(db.$queryRaw`SELECT 1`).resolves.toEqual([{ ok: true }]);
    await expect(db.$transaction(async (tx) => tx === (h.tx as unknown))).resolves.toBe(true);

    expect(h.contexts).toEqual(['tenant-2', 'tenant-2']);
  });

  it('lehnt die Array-Form von $transaction ab', () => {
    const db = systemContextClient('tenant-3');

    expect(() => db.$transaction([] as never)).toThrow('nur $transaction(fn)');
    expect(h.withSystemContext).not.toHaveBeenCalled();
  });
});
