// =============================================================================
// Unit-Test: toActionError aus rbac.ts.
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
//
// Audit Round 14, Finding 3: Unbekannte Errors dürfen NIE direkt ans UI
// durchgereicht werden — könnten Stacktraces oder DB-Internals leaken.
// Dieser Test fängt jede Regression, die das auflöst (etwa: "ah, wir
// werfen einfach `error: e.message` zurück, dann sehen wir die Ursache
// schneller im UI").
//
// Verwendet vi.mock, um den pino-Logger zu kapseln. Geprüft werden das
// Rückgabeverhalten und, für Ops-relevante Fehler, Level und Felder des
// Log-Eintrags; Zeilenwerte aus Datenbankfehlern dürfen nicht ins Log.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@taxtronik/db/prisma-client';

// Logger mocken, bevor rbac importiert wird — sonst zieht der pino-Import
// die echte ENV-Validierung an.
vi.mock('@/server/logger', () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Auth-Modul wird transitiv gezogen, mocken wir auch.
vi.mock('@/server/auth/staff', () => ({
  staffAuth: vi.fn(),
}));

import {
  toActionError,
  UnauthorizedError,
  ForbiddenError,
  canAccessClientTx,
  canOtherStaffAccessClientTx,
  filterStaffAccessClientTx,
  accessibleClientsWhereFor,
  hasStaffPermission,
} from '../rbac';
import type { StaffSession } from '../staff';
import { log } from '@/server/logger';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toActionError', () => {
  it('UnauthorizedError → eigene Message wird durchgereicht', () => {
    const r = toActionError(new UnauthorizedError());
    expect(r).toEqual({ ok: false, error: 'Nicht eingeloggt.' });
  });

  it('ForbiddenError → eigene Message wird durchgereicht', () => {
    const r = toActionError(new ForbiddenError());
    expect(r).toEqual({ ok: false, error: 'Nur ADMIN/PARTNER.' });
  });

  it('Session-Revocation-Ausfall → stabile Meldung ohne Redis-Interna', () => {
    const error = new Error('redis://10.0.0.5:6379 timeout');
    error.name = 'SessionRevocationUnavailableError';
    const r = toActionError(error);
    expect(r).toEqual({
      ok: false,
      error: 'Session-Widerruf ist derzeit nicht verfügbar.',
    });
    expect(r.error).not.toMatch(/redis|10\.0\.0\.5/i);
  });

  it('Prisma P2025 (not found) → menschenlesbare Meldung, kein Stack', () => {
    const e = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const r = toActionError(e);
    expect(r).toEqual({ ok: false, error: 'Datensatz nicht gefunden oder bereits geändert.' });
  });

  it('Prisma P2002 (unique) → menschenlesbare Meldung', () => {
    const e = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(toActionError(e).error).toMatch(/existiert bereits/i);
  });

  it('Prisma-Unbekannt → generische "Datenbankfehler"-Meldung (keine Internals)', () => {
    const e = new Prisma.PrismaClientKnownRequestError(
      'P9999 — exotischer Fehler mit internem Pfad /var/lib/postgresql/data/base/16384/2615',
      { code: 'P9999', clientVersion: 'test' },
    );
    const r = toActionError(e);
    expect(r.error).toBe('Datenbankfehler.');
    expect(r.error).not.toMatch(/postgresql/);
    expect(r.error).not.toMatch(/P9999/);
  });

  it('Unbekannte Exception → generische Meldung, NIE die original-Message', () => {
    const e = new Error(
      'Internal: connection to redis at 10.0.0.5:6379 timed out at /app/src/server/redis.ts:42',
    );
    const r = toActionError(e);
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/redis/);
    expect(r.error).not.toMatch(/10\.0\.0\.5/);
    expect(r.error).not.toMatch(/app\/src\/server/);
    expect(r.error).toMatch(/Unerwarteter Fehler/);
  });

  it('Unbekannte Exception → Original landet im Logger (für Ops)', () => {
    const e = new Error('Original-Message für Ops');
    toActionError(e);
    expect(log.error).toHaveBeenCalledOnce();
    const [logArgs] = vi.mocked(log.error).mock.calls[0]!;
    expect(logArgs).toMatchObject({
      component: 'action-error',
      err: 'Original-Message für Ops',
    });
  });

  it('Prisma P2025/P2002 → als erwartbarer Konflikt mit warn im Log', () => {
    for (const code of ['P2025', 'P2002']) {
      toActionError(
        new Prisma.PrismaClientKnownRequestError(`Konflikt ${code}`, {
          code,
          clientVersion: 'test',
          meta: { modelName: 'Document' },
        }),
      );
    }
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls.map(([fields]) => fields)).toEqual([
      expect.objectContaining({
        component: 'action-error',
        prismaCode: 'P2025',
        modelName: 'Document',
      }),
      expect.objectContaining({
        component: 'action-error',
        prismaCode: 'P2002',
        modelName: 'Document',
      }),
    ]);
  });

  it('Prisma-Timeout, Serialisierungskonflikt, Pool → error im Log, UI bleibt generisch', () => {
    for (const code of ['P2028', 'P2034', 'P2024']) {
      const r = toActionError(
        new Prisma.PrismaClientKnownRequestError(`Fehler ${code}`, {
          code,
          clientVersion: 'test',
        }),
      );
      expect(r).toEqual({ ok: false, error: 'Datenbankfehler.' });
    }
    expect(log.warn).not.toHaveBeenCalled();
    expect(vi.mocked(log.error).mock.calls.map(([fields]) => fields)).toEqual(
      ['P2028', 'P2034', 'P2024'].map((code) =>
        expect.objectContaining({
          component: 'action-error',
          prismaCode: code,
          err: `Fehler ${code}`,
        }),
      ),
    );
  });

  it('Driver-Adapter-Fehler → SQLSTATE und Constraint im Log, aber keine Zeilenwerte', () => {
    toActionError(
      new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `23514`.', {
        code: 'P2010',
        clientVersion: 'test',
        meta: {
          modelName: 'Client',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '23514',
              kind: 'postgres',
              detail: 'Failing row contains (mueller@example.test, Geheim GmbH).',
              constraint: { index: 'client_name_check' },
            },
          },
        },
      }),
    );
    expect(log.error).toHaveBeenCalledOnce();
    const [fields] = vi.mocked(log.error).mock.calls[0]!;
    expect(fields).toMatchObject({
      prismaCode: 'P2010',
      modelName: 'Client',
      sqlState: '23514',
      constraint: 'client_name_check',
    });
    expect(JSON.stringify(fields)).not.toMatch(/mueller@example\.test|Geheim GmbH/);
  });

  it('Nicht-Error-Wurf (etwa string oder number) → generische Meldung', () => {
    // Defensive: `throw "string"` ist schlechter Stil, aber kommt vor.
    const r = toActionError('boom');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unerwarteter Fehler/);
  });
});

// =============================================================================
// canAccessClientTx / accessibleClientsWhereFor — Vertraulich-/RESTRICTED-Gate
// auf Stub-Tx (kein DB-Zugriff). Die reine Entscheidungslogik testet
// access-policy (decideClientAccess); hier geht es um die Tx-Orchestrierung:
// Policy lesen → Mandant lesen → Responsibility nur wenn nötig.
// =============================================================================

function makeSession(roles: string[], permissions: string[] = []): StaffSession {
  return {
    user: {
      id: 'u1',
      email: 'm@kanzlei.de',
      name: 'M',
      fullName: 'Mitarbeiter Eins',
      tenantId: 't1',
      staffId: 's1',
      roles,
      permissions,
    },
  } as StaffSession;
}

// iter87: Einzelrecht-Wahrheitstabelle — ADMIN/PARTNER implizit alles,
// EMPLOYEE nur mit explizitem Grant in der Session.
describe('hasStaffPermission', () => {
  it('ADMIN/PARTNER → implizit alle Rechte, ohne Grant', () => {
    expect(hasStaffPermission(makeSession(['ADMIN']), 'INVOICE_SEND')).toBe(true);
    expect(hasStaffPermission(makeSession(['PARTNER']), 'ABSENCE_DECIDE')).toBe(true);
  });

  it('EMPLOYEE ohne Grant → kein Recht', () => {
    expect(hasStaffPermission(makeSession(['EMPLOYEE']), 'INVOICE_MANAGE')).toBe(false);
  });

  it('EMPLOYEE mit Grant → genau dieses Recht', () => {
    const s = makeSession(['EMPLOYEE'], ['INVOICE_MANAGE']);
    expect(hasStaffPermission(s, 'INVOICE_MANAGE')).toBe(true);
    expect(hasStaffPermission(s, 'INVOICE_SEND')).toBe(false);
  });

  it('keine Session / fehlende Felder → fail-closed', () => {
    expect(hasStaffPermission(null, 'INVOICE_SEND')).toBe(false);
    expect(hasStaffPermission(undefined, 'INVOICE_SEND')).toBe(false);
    expect(hasStaffPermission({ user: { roles: ['EMPLOYEE'] } } as never, 'INVOICE_SEND')).toBe(
      false,
    );
  });
});

interface StubTxConfig {
  mode?: 'OPEN' | 'RESTRICTED';
  client?: { vertraulich: boolean } | null;
  responsible?: boolean;
}

function makeTx(cfg: StubTxConfig) {
  const responsibilityFindFirst = vi.fn(async () => (cfg.responsible ? { id: 'r1' } : null));
  const settingFindUnique = vi.fn(async () =>
    cfg.mode ? { value: { clientAccessMode: cfg.mode } } : null,
  );
  const clientFindMany = vi.fn(async () => []);
  const tx = {
    tenantSetting: { findUnique: settingFindUnique },
    client: {
      findUnique: vi.fn(async () => cfg.client ?? null),
      findMany: clientFindMany,
    },
    clientResponsibility: { findFirst: responsibilityFindFirst },
  };
  // Cast über never: Stub deckt nur die von den Helfern berührte Tx-Fläche ab.
  return { tx: tx as never, clientFindMany, responsibilityFindFirst, settingFindUnique };
}

describe('canAccessClientTx', () => {
  it('Admin/Partner → Zugriff ohne jede Query', async () => {
    const { tx, responsibilityFindFirst } = makeTx({});
    await expect(canAccessClientTx(tx, makeSession(['ADMIN']), 'c1')).resolves.toBe(true);
    expect(responsibilityFindFirst).not.toHaveBeenCalled();
  });

  it('OPEN + nicht vertraulich → Zugriff, Responsibility wird NICHT abgefragt', async () => {
    const { tx, responsibilityFindFirst } = makeTx({
      mode: 'OPEN',
      client: { vertraulich: false },
    });
    await expect(canAccessClientTx(tx, makeSession(['STAFF']), 'c1')).resolves.toBe(true);
    expect(responsibilityFindFirst).not.toHaveBeenCalled();
  });

  it('OPEN + vertraulich → nur mit Zuordnung', async () => {
    const denied = makeTx({ mode: 'OPEN', client: { vertraulich: true }, responsible: false });
    await expect(canAccessClientTx(denied.tx, makeSession(['STAFF']), 'c1')).resolves.toBe(false);
    const granted = makeTx({ mode: 'OPEN', client: { vertraulich: true }, responsible: true });
    await expect(canAccessClientTx(granted.tx, makeSession(['STAFF']), 'c1')).resolves.toBe(true);
  });

  it('RESTRICTED → nur mit Zuordnung, auch ohne vertraulich-Flag', async () => {
    const denied = makeTx({
      mode: 'RESTRICTED',
      client: { vertraulich: false },
      responsible: false,
    });
    await expect(canAccessClientTx(denied.tx, makeSession(['STAFF']), 'c1')).resolves.toBe(false);
    const granted = makeTx({
      mode: 'RESTRICTED',
      client: { vertraulich: false },
      responsible: true,
    });
    await expect(canAccessClientTx(granted.tx, makeSession(['STAFF']), 'c1')).resolves.toBe(true);
  });

  it('Mandant existiert nicht (oder fremder Tenant via RLS) → kein Zugriff', async () => {
    const { tx } = makeTx({ mode: 'OPEN', client: null });
    await expect(canAccessClientTx(tx, makeSession(['STAFF']), 'c1')).resolves.toBe(false);
  });
});

describe('accessibleClientsWhereFor', () => {
  it('Admin/Partner erhalten keinen zusätzlichen Filter und lösen keine Query aus', async () => {
    for (const role of ['ADMIN', 'PARTNER']) {
      const { tx, settingFindUnique, clientFindMany } = makeTx({ mode: 'RESTRICTED' });
      await expect(accessibleClientsWhereFor(tx, makeSession([role]))).resolves.toEqual({});
      expect(settingFindUnique).not.toHaveBeenCalled();
      expect(clientFindMany).not.toHaveBeenCalled();
    }
  });

  it('lädt keine Mandanten-IDs (keine NOT-IN-Liste, P-09)', async () => {
    for (const mode of ['OPEN', 'RESTRICTED'] as const) {
      const { tx, clientFindMany, settingFindUnique } = makeTx({ mode });
      const where = await accessibleClientsWhereFor(tx, makeSession(['STAFF']));
      expect(clientFindMany).not.toHaveBeenCalled();
      expect(settingFindUnique).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(where)).not.toContain('notIn');
    }
  });

  it('OPEN erlaubt öffentliche Mandanten oder eine eigene Verantwortung', async () => {
    const { tx } = makeTx({ mode: 'OPEN' });
    await expect(accessibleClientsWhereFor(tx, makeSession(['STAFF']))).resolves.toEqual({
      OR: [
        { vertraulich: false },
        {
          responsibilities: {
            some: {
              staffId: 's1',
              role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] },
            },
          },
        },
      ],
    });
  });

  it('RESTRICTED filtert positiv auf eigene Verantwortungen', async () => {
    const { tx } = makeTx({ mode: 'RESTRICTED' });
    await expect(accessibleClientsWhereFor(tx, makeSession(['STAFF']))).resolves.toEqual({
      responsibilities: {
        some: {
          staffId: 's1',
          role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] },
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// filterStaffAccessClientTx: Batch-Entscheidung fuer die Zuweisungs-Liste.
// Eigener Stub, weil hier staffUser.findMany + clientResponsibility.findMany
// gebraucht werden (die Einzel-Helfer oben beruehren andere Tx-Flaechen).
// ---------------------------------------------------------------------------

interface BatchTxConfig {
  mode?: 'OPEN' | 'RESTRICTED';
  client?: { vertraulich: boolean } | null;
  /** id → Rollen des (aktiven) Mitarbeiters; fehlende IDs gelten als inaktiv/fremd. */
  staff?: Record<string, string[]>;
  /** IDs mit BERUFSTRAEGER/HAUPTBEARBEITER-Zuordnung am Mandanten. */
  responsibleIds?: string[];
}

function makeBatchTx(cfg: BatchTxConfig) {
  const staffFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in
      .filter((id) => cfg.staff?.[id])
      .map((id) => ({ id, roles: cfg.staff![id]!.map((role) => ({ role })) })),
  );
  const responsibilityFindMany = vi.fn(async () =>
    (cfg.responsibleIds ?? []).map((staffId) => ({ staffId })),
  );
  const clientFindFirst = vi.fn(async () => cfg.client ?? null);
  const tx = {
    tenantSetting: {
      findUnique: vi.fn(async () => (cfg.mode ? { value: { clientAccessMode: cfg.mode } } : null)),
    },
    client: { findFirst: clientFindFirst },
    staffUser: { findMany: staffFindMany },
    clientResponsibility: { findMany: responsibilityFindMany },
  };
  return { tx: tx as never, staffFindMany, responsibilityFindMany, clientFindFirst };
}

describe('filterStaffAccessClientTx', () => {
  it('OPEN + nicht vertraulich: alle aktiven durch, ohne Responsibility-Query', async () => {
    const { tx, responsibilityFindMany } = makeBatchTx({
      mode: 'OPEN',
      client: { vertraulich: false },
      staff: { a: ['STAFF'], b: ['STAFF'] },
    });
    const erlaubt = await filterStaffAccessClientTx(tx, 't1', ['a', 'b'], 'c1');
    expect([...erlaubt].sort()).toEqual(['a', 'b']);
    expect(responsibilityFindMany).not.toHaveBeenCalled();
  });

  it('vertraulicher Mandant: Admin/Partner und Zugeordnete, sonst niemand', async () => {
    const { tx, responsibilityFindMany, clientFindFirst } = makeBatchTx({
      mode: 'OPEN',
      client: { vertraulich: true },
      staff: { admin: ['ADMIN'], zust: ['STAFF'], fremd: ['STAFF'] },
      responsibleIds: ['zust'],
    });
    const erlaubt = await filterStaffAccessClientTx(tx, 't1', ['admin', 'zust', 'fremd'], 'c1');
    expect([...erlaubt].sort()).toEqual(['admin', 'zust']);
    expect(clientFindFirst).toHaveBeenCalledWith({
      where: { id: 'c1', tenantId: 't1' },
      select: { vertraulich: true },
    });
    expect(responsibilityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't1', clientId: 'c1' }),
      }),
    );
  });

  it('inaktive/fremde IDs und fehlender Mandant fallen heraus', async () => {
    const inaktiv = makeBatchTx({
      mode: 'OPEN',
      client: { vertraulich: false },
      staff: { a: ['STAFF'] },
    });
    const nurA = await filterStaffAccessClientTx(inaktiv.tx, 't1', ['a', 'weg'], 'c1');
    expect([...nurA]).toEqual(['a']);

    const ohneMandant = makeBatchTx({ mode: 'OPEN', client: null, staff: { a: ['STAFF'] } });
    await expect(filterStaffAccessClientTx(ohneMandant.tx, 't1', ['a'], 'c1')).resolves.toEqual(
      new Set(),
    );
  });

  it('leere Eingabe: gar keine Query', async () => {
    const { tx, staffFindMany } = makeBatchTx({});
    await expect(filterStaffAccessClientTx(tx, 't1', [], 'c1')).resolves.toEqual(new Set());
    expect(staffFindMany).not.toHaveBeenCalled();
  });

  it('Einzel-Helfer entscheidet identisch (delegiert an den Batch)', async () => {
    const granted = makeBatchTx({
      mode: 'RESTRICTED',
      client: { vertraulich: false },
      staff: { zust: ['STAFF'] },
      responsibleIds: ['zust'],
    });
    await expect(canOtherStaffAccessClientTx(granted.tx, 't1', 'zust', 'c1')).resolves.toBe(true);

    const denied = makeBatchTx({
      mode: 'RESTRICTED',
      client: { vertraulich: false },
      staff: { fremd: ['STAFF'] },
    });
    await expect(canOtherStaffAccessClientTx(denied.tx, 't1', 'fremd', 'c1')).resolves.toBe(false);
  });
});
