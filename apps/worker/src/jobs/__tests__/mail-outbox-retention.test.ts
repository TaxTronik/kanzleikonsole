// Fachkatalog: MAIL-OUTBOX-001, DSGVO-OPERATIONAL-RETENTION-001
// Welle 15 (Entscheidung A8): Löschfrist der Mail-Outbox-Metadaten. Stichtag
// wie die Steuertermin-Versandhistorie (ein Kalenderjahr), Stapel je Tenant im
// SYSTEM-Kontext, Zeitbudget der Wartungsjobs (P-17), Rückstand und Zähler im
// Log. Die SQL-Funktion, die Grenze und den Cross-Tenant-Schutz prüft
// mail-outbox-retention-db.test.ts gegen PostgreSQL.
import { MailOutboxStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Je Tenant die Löschzahlen der aufeinanderfolgenden Funktionsaufrufe. */
  purges: new Map<string, number[]>(),
  calls: [] as Array<{ tenantId: string; cutoff: Date; limit: number }>,
  backlog: new Map<string, number>(),
  countWheres: [] as unknown[],
  tenants: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: { tenant: { findMany: h.tenants } } }));
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (tenantId: string, run: (tx: unknown) => unknown) =>
    run({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        expect(strings.join('?')).toContain('app.mail_outbox_purge_terminal(');
        h.calls.push({ tenantId, cutoff: values[0] as Date, limit: values[1] as number });
        const next = h.purges.get(tenantId)?.shift() ?? 0;
        return [{ deleted: next }];
      },
      mailOutbox: {
        count: async (args: { where: unknown }) => {
          h.countWheres.push(args.where);
          return h.backlog.get(tenantId) ?? 0;
        },
      },
    }),
}));

import { processors } from './mocks/bullmq';
import {
  dueMailOutboxWhere,
  MAIL_OUTBOX_RETENTION_BATCH_SIZE,
  MAIL_OUTBOX_TERMINAL_STATUSES,
  mailOutboxRetentionCutoff,
  mailOutboxRetentionWorker,
  runMailOutboxRetention,
} from '../mail-outbox-retention';

const NOW = new Date('2026-10-12T04:15:00.000Z');
const CUTOFF = new Date('2025-10-12T04:15:00.000Z');
const NO_LIMIT = { exhausted: () => false };

beforeEach(() => {
  vi.clearAllMocks();
  h.purges.clear();
  h.calls.length = 0;
  h.backlog.clear();
  h.countWheres.length = 0;
  h.tenants.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
});

describe('mail-outbox-retention: Frist und Status', () => {
  it('setzt den Stichtag ein Kalenderjahr zurück wie die Steuertermin-Versandhistorie', () => {
    expect(mailOutboxRetentionCutoff(NOW).toISOString()).toBe(CUTOFF.toISOString());
    // Dieselbe Rechnung wie yearsAgo() in dsgvo-retention.ts (setFullYear).
    const leap = new Date(2028, 1, 29, 12, 0, 0);
    const expected = new Date(leap.getTime());
    expected.setFullYear(2027);
    expect(mailOutboxRetentionCutoff(leap).getTime()).toBe(expected.getTime());
  });

  it('löscht nur Endstatus; wartende und laufende Aufträge nie', () => {
    const all = Object.values(MailOutboxStatus);
    expect([...MAIL_OUTBOX_TERMINAL_STATUSES].sort()).toEqual(
      all.filter((status) => !['QUEUED', 'RETRY_PENDING', 'SENDING'].includes(status)).sort(),
    );
    const where = JSON.stringify(dueMailOutboxWhere('tenant-a', CUTOFF));
    for (const active of ['QUEUED', 'RETRY_PENDING', 'SENDING']) {
      expect(where).not.toContain(`"${active}"`);
    }
    expect(dueMailOutboxWhere('tenant-a', CUTOFF)).toEqual({
      tenantId: 'tenant-a',
      OR: [
        {
          status: { in: ['PROVIDER_ACCEPTED', 'PARTIAL_FAILURE', 'NO_RECIPIENT', 'SKIPPED'] },
          updatedAt: { lt: CUTOFF },
        },
        {
          status: { in: ['FAILED', 'UNKNOWN'] },
          OR: [{ escalatedAt: { lt: CUTOFF } }, { escalatedAt: null, updatedAt: { lt: CUTOFF } }],
        },
      ],
    });
  });
});

describe('mail-outbox-retention: Lauf', () => {
  it('löscht je Tenant in dessen Kontext stapelweise, bis ein Stapel nicht voll ist', async () => {
    h.purges.set('tenant-a', [
      MAIL_OUTBOX_RETENTION_BATCH_SIZE,
      MAIL_OUTBOX_RETENTION_BATCH_SIZE,
      7,
    ]);
    h.purges.set('tenant-b', [0]);

    const result = await runMailOutboxRetention({ now: NOW, budget: NO_LIMIT });

    expect(result).toEqual({
      deleted: 2 * MAIL_OUTBOX_RETENTION_BATCH_SIZE + 7,
      tenantsWithDeletions: 1,
      cutoff: CUTOFF.toISOString(),
      backlog: 0,
      budgetExhausted: false,
    });
    expect(h.calls.map((call) => call.tenantId)).toEqual([
      'tenant-a',
      'tenant-a',
      'tenant-a',
      'tenant-b',
    ]);
    for (const call of h.calls) {
      expect(call.cutoff.toISOString()).toBe(CUTOFF.toISOString());
      expect(call.limit).toBe(MAIL_OUTBOX_RETENTION_BATCH_SIZE);
    }
    expect(h.countWheres).toEqual([
      dueMailOutboxWhere('tenant-a', CUTOFF),
      dueMailOutboxWhere('tenant-b', CUTOFF),
    ]);
    // Zähler je Tenant (nur bei Treffern) und die Zusammenfassung im Log.
    expect(h.log.info).toHaveBeenCalledWith(
      {
        component: 'mail-outbox-retention',
        tenantId: 'tenant-a',
        deleted: 2 * MAIL_OUTBOX_RETENTION_BATCH_SIZE + 7,
        cutoff: CUTOFF.toISOString(),
      },
      'mail-outbox-retention: terminal outbox rows deleted',
    );
    expect(h.log.info).toHaveBeenCalledWith(
      { component: 'mail-outbox-retention', ...result },
      'mail-outbox-retention finished',
    );
    expect(h.log.info).toHaveBeenCalledTimes(2);
  });

  it('ist idempotent: ohne fällige Aufträge löscht ein Lauf nichts', async () => {
    const result = await runMailOutboxRetention({ now: NOW, budget: NO_LIMIT });
    expect(result).toMatchObject({ deleted: 0, tenantsWithDeletions: 0, backlog: 0 });
    expect(h.calls).toHaveLength(2);
  });

  it('begrenzt einen gezielten Lauf auf die angegebenen Tenants', async () => {
    await runMailOutboxRetention({ now: NOW, budget: NO_LIMIT, tenantIds: ['tenant-a'] });
    expect(h.tenants).toHaveBeenCalledWith({
      where: { id: { in: ['tenant-a'] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  });

  it('endet am Zeitbudget und meldet den Rückstand aller Tenants', async () => {
    h.purges.set('tenant-a', [MAIL_OUTBOX_RETENTION_BATCH_SIZE, MAIL_OUTBOX_RETENTION_BATCH_SIZE]);
    h.backlog.set('tenant-a', 300);
    h.backlog.set('tenant-b', 4);
    let checks = 0;
    const budget = { exhausted: () => ++checks > 1 };

    const result = await runMailOutboxRetention({ now: NOW, budget });

    expect(result).toEqual({
      deleted: MAIL_OUTBOX_RETENTION_BATCH_SIZE,
      tenantsWithDeletions: 1,
      cutoff: CUTOFF.toISOString(),
      backlog: 304,
      budgetExhausted: true,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      { component: 'mail-outbox-retention', ...result },
      'mail-outbox-retention: Zeitbudget erreicht, Rückstand im nächsten Lauf',
    );
  });

  it('Worker: liefert das Ergebnis als Job-Rückgabe und hört beim Herunterfahren auf', async () => {
    h.backlog.set('tenant-a', 2);
    const proc = processors.get('mail-outbox-retention')!;
    const worker = mailOutboxRetentionWorker as unknown as { closing?: Promise<void> };
    worker.closing = Promise.resolve();
    try {
      await expect(proc({ data: {} })).resolves.toMatchObject({
        deleted: 0,
        backlog: 2,
        budgetExhausted: true,
      });
      expect(h.calls).toHaveLength(0);
    } finally {
      delete worker.closing;
    }
    h.purges.set('tenant-a', [2]);
    h.backlog.set('tenant-a', 0);
    await expect(proc({ data: {} })).resolves.toMatchObject({
      deleted: 2,
      backlog: 0,
      budgetExhausted: false,
    });
  });
});
