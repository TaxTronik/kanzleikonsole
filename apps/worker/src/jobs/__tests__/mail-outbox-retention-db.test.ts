// Fachkatalog: MAIL-OUTBOX-001, DSGVO-OPERATIONAL-RETENTION-001
// =============================================================================
// Welle 15 (A8): mail-outbox-retention gegen echtes PostgreSQL.
//
// Belegt, was der Mock-Test nicht prüfen kann: app.mail_outbox_purge_terminal
// unter der App-Rolle im SYSTEM-Kontext (withSystemContext, RLS), die Grenze
// von genau einem Jahr (strikt älter wird gelöscht), dass wartende und laufende
// Aufträge auch uralt bleiben, dass bei FAILED/UNKNOWN die Eskalation und nicht
// das spätere Entfernen des Neuversandinhalts zählt, mehrere Stapel, die
// Übereinstimmung von Rückstandszählung und Funktion, Idempotenz und die
// Tenant-Grenze. Die Läufe sind auf die eigenen Tenants begrenzt. Nur mit
// ausdrücklichem Opt-in (WORKER_DB_TEST=1 bzw. DB_TESTS=1).
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { MailOutboxStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// B-02: lokal per WORKER_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  let url: URL;
  try {
    url = new URL(process.env['DATABASE_URL'] ?? '');
  } catch {
    throw new Error('WORKER_DB_TEST requires a valid DATABASE_URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname.length < 2 ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('WORKER_DB_TEST requires a loopback PostgreSQL DATABASE_URL.');
  }
}

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { withSystemContext, withTenantContext } from '@taxtronik/db';
import { prismaOwner } from '../../prisma-owner';
import {
  dueMailOutboxWhere,
  MAIL_OUTBOX_RETENTION_BATCH_SIZE,
  mailOutboxRetentionCutoff,
  runMailOutboxRetention,
} from '../mail-outbox-retention';

const describeDb = enabled ? describe : describe.skip;
const NO_LIMIT = { exhausted: () => false };
const MS_DAY = 24 * 60 * 60_000;

interface RowSpec {
  status: MailOutboxStatus;
  updatedAt: Date;
  escalatedAt?: Date | null;
}

describeDb('Welle 15 mail-outbox-retention against PostgreSQL', () => {
  const tenants = {
    a: { tenantId: '', clientId: '', staffId: '' },
    b: { tenantId: '', clientId: '', staffId: '' },
  };
  const now = new Date();
  const cutoff = mailOutboxRetentionCutoff(now);
  const ids = new Map<string, string>();

  async function createRow(tenant: keyof typeof tenants, name: string, spec: RowSpec) {
    const { tenantId, clientId } = tenants[tenant];
    const waiting = spec.status === 'QUEUED' || spec.status === 'RETRY_PENDING';
    const row = await prismaOwner.mailOutbox.create({
      data: {
        tenantId,
        clientId,
        kind: 'DIRECT',
        purpose: 'handover-ready',
        resourceType: 'client_handover',
        resourceId: randomUUID(),
        staffHref: `/staff/clients/${clientId}`,
        payload: waiting ? { v: 1, slug: 'handover-ready', to: 'x@example.test', vars: {} } : {},
        status: spec.status,
        nextAttemptAt: waiting ? now : null,
      },
      select: { id: true },
    });
    // updated_at/escalated_at gezielt setzen (Prisma setzt @updatedAt selbst).
    await prismaOwner.$executeRaw`
      UPDATE public."mail_outbox"
         SET "updated_at" = ${spec.updatedAt}, "escalated_at" = ${spec.escalatedAt ?? null}
       WHERE "id" = ${row.id}::uuid`;
    ids.set(name, row.id);
    return row.id;
  }

  async function exists(name: string): Promise<boolean> {
    return (await prismaOwner.mailOutbox.count({ where: { id: ids.get(name)! } })) === 1;
  }

  const older = new Date(cutoff.getTime() - 1);
  const ancient = new Date(cutoff.getTime() - 400 * MS_DAY);

  beforeAll(async () => {
    const suffix = randomUUID();
    for (const [key, entry] of Object.entries(tenants)) {
      entry.tenantId = (
        await prismaOwner.tenant.create({
          data: { slug: `w15-outbox-${key}-${suffix}`, name: `W15 Outbox ${key}` },
        })
      ).id;
      entry.clientId = (
        await prismaOwner.client.create({
          data: { tenantId: entry.tenantId, kind: 'NATPERS', name: `W15 Mandant ${key}` },
        })
      ).id;
      entry.staffId = (
        await prismaOwner.staffUser.create({
          data: {
            tenantId: entry.tenantId,
            email: `w15-outbox-${key}-${suffix}@example.test`,
            fullName: 'W15 Admin',
            passwordHash: 'synthetic',
            roles: { create: { role: 'ADMIN' } },
          },
        })
      ).id;
    }

    // Grenze genau ein Jahr: am Stichtag bleibt, eine Millisekunde älter geht.
    await createRow('a', 'accepted-at-cutoff', { status: 'PROVIDER_ACCEPTED', updatedAt: cutoff });
    await createRow('a', 'accepted-older', { status: 'PROVIDER_ACCEPTED', updatedAt: older });
    await createRow('a', 'accepted-newer', {
      status: 'PROVIDER_ACCEPTED',
      updatedAt: new Date(cutoff.getTime() + MS_DAY),
    });
    await createRow('a', 'partial-older', {
      status: 'PARTIAL_FAILURE',
      updatedAt: older,
      escalatedAt: older,
    });
    await createRow('a', 'no-recipient-older', { status: 'NO_RECIPIENT', updatedAt: older });
    await createRow('a', 'skipped-older', { status: 'SKIPPED', updatedAt: older });
    // FAILED/UNKNOWN: Eskalation vor dem Stichtag; der Neuversandinhalt wurde 30
    // Tage später entfernt (updated_at jünger als der Stichtag) – zählt nicht.
    await createRow('a', 'failed-escalated-older', {
      status: 'FAILED',
      escalatedAt: older,
      updatedAt: new Date(older.getTime() + 30 * MS_DAY),
    });
    await createRow('a', 'unknown-escalated-at-cutoff', {
      status: 'UNKNOWN',
      escalatedAt: cutoff,
      updatedAt: new Date(cutoff.getTime() + 30 * MS_DAY),
    });
    // Wartende und laufende Aufträge bleiben auch uralt.
    await createRow('a', 'queued-ancient', { status: 'QUEUED', updatedAt: ancient });
    await createRow('a', 'retry-ancient', { status: 'RETRY_PENDING', updatedAt: ancient });
    await createRow('a', 'sending-ancient', { status: 'SENDING', updatedAt: ancient });
    // Fremder Tenant mit fälligem Auftrag.
    await createRow('b', 'foreign-older', { status: 'PROVIDER_ACCEPTED', updatedAt: ancient });

    // Mehr als ein Stapel fälliger Aufträge in Tenant A.
    const bulk = Array.from({ length: MAIL_OUTBOX_RETENTION_BATCH_SIZE + 3 }, () => ({
      tenantId: tenants.a.tenantId,
      clientId: tenants.a.clientId,
      kind: 'DIRECT' as const,
      purpose: 'invoice-sent',
      resourceType: 'invoice',
      resourceId: randomUUID(),
      staffHref: '/staff/invoices',
      payload: {},
      status: 'PROVIDER_ACCEPTED' as const,
      nextAttemptAt: null,
      lastError: 'w15-bulk',
    }));
    await prismaOwner.mailOutbox.createMany({ data: bulk });
    await prismaOwner.$executeRaw`
      UPDATE public."mail_outbox" SET "updated_at" = ${ancient}
       WHERE "tenant_id" = ${tenants.a.tenantId}::uuid AND "last_error" = 'w15-bulk'`;
  });

  afterAll(async () => {
    for (const { tenantId } of Object.values(tenants)) {
      if (tenantId) await prismaOwner.tenant.delete({ where: { id: tenantId } });
    }
  });

  it('weist die Funktion außerhalb des SYSTEM-Kontexts und bei zu jungem Stichtag ab', async () => {
    const { tenantId, staffId } = tenants.a;
    await expect(
      withTenantContext(
        { tenantId, actorId: staffId, actorType: 'STAFF' },
        (tx) => tx.$queryRaw`SELECT app.mail_outbox_purge_terminal(${cutoff}::timestamptz, 10)`,
      ),
    ).rejects.toThrow(/MAIL_OUTBOX_PURGE_CONTEXT/);
    // Die App-Rolle hat weiterhin kein DELETE auf mail_outbox.
    await expect(
      withSystemContext(tenantId, (tx) =>
        tx.mailOutbox.deleteMany({ where: { id: ids.get('accepted-older')! } }),
      ),
    ).rejects.toThrow(/permission denied/);
    const recent = new Date(now.getTime() - 300 * MS_DAY);
    await expect(
      withSystemContext(
        tenantId,
        (tx) => tx.$queryRaw`SELECT app.mail_outbox_purge_terminal(${recent}::timestamptz, 10)`,
      ),
    ).rejects.toThrow(/MAIL_OUTBOX_PURGE_CUTOFF/);
    await expect(
      withSystemContext(
        tenantId,
        (tx) => tx.$queryRaw`SELECT app.mail_outbox_purge_terminal(${cutoff}::timestamptz, 0)`,
      ),
    ).rejects.toThrow(/MAIL_OUTBOX_PURGE_LIMIT/);
    expect(await exists('accepted-older')).toBe(true);
  });

  it('löscht im Kontext eines fremden Tenants keine Aufträge anderer Kanzleien', async () => {
    const [row] = await withSystemContext(
      tenants.b.tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ deleted: number }>>`
          SELECT app.mail_outbox_purge_terminal(${cutoff}::timestamptz, 1000) AS "deleted"`,
    );
    expect(row?.deleted).toBe(1);
    expect(await exists('foreign-older')).toBe(false);
    expect(await exists('accepted-older')).toBe(true);
  });

  it('löscht Endstatus strikt älter als ein Jahr, in Stapeln, und lässt alles andere', async () => {
    const dueBefore = await prismaOwner.mailOutbox.count({
      where: dueMailOutboxWhere(tenants.a.tenantId, cutoff),
    });
    // 503 Massenaufträge + accepted, partial, no-recipient, skipped, failed.
    expect(dueBefore).toBe(MAIL_OUTBOX_RETENTION_BATCH_SIZE + 3 + 5);

    const result = await runMailOutboxRetention({
      now,
      budget: NO_LIMIT,
      tenantIds: [tenants.a.tenantId],
    });

    // Die Rückstandszählung (Prisma) und die Funktion (SQL) treffen dieselben Zeilen.
    expect(result).toEqual({
      deleted: dueBefore,
      tenantsWithDeletions: 1,
      cutoff: cutoff.toISOString(),
      backlog: 0,
      budgetExhausted: false,
    });
    for (const gone of [
      'accepted-older',
      'partial-older',
      'no-recipient-older',
      'skipped-older',
      'failed-escalated-older',
    ]) {
      expect({ gone, exists: await exists(gone) }).toEqual({ gone, exists: false });
    }
    for (const kept of [
      'accepted-at-cutoff',
      'accepted-newer',
      'unknown-escalated-at-cutoff',
      'queued-ancient',
      'retry-ancient',
      'sending-ancient',
    ]) {
      expect({ kept, exists: await exists(kept) }).toEqual({ kept, exists: true });
    }
    expect(
      await prismaOwner.mailOutbox.count({
        where: { tenantId: tenants.a.tenantId, lastError: 'w15-bulk' },
      }),
    ).toBe(0);
  });

  it('ist idempotent: ein zweiter Lauf findet nichts mehr', async () => {
    const result = await runMailOutboxRetention({
      now,
      budget: NO_LIMIT,
      tenantIds: [tenants.a.tenantId, tenants.b.tenantId],
    });
    expect(result).toMatchObject({ deleted: 0, tenantsWithDeletions: 0, backlog: 0 });
    expect(await prismaOwner.mailOutbox.count({ where: { tenantId: tenants.a.tenantId } })).toBe(6);
  });
});
