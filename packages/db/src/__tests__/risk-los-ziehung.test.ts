// =============================================================================
// Fachkatalog: TCMS-SAMPLE-PROOF-001
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Welle 15 (Folgepunkt P-11): Los-Ziehungen in risk_los_ziehung
// (Migration 20261012100000_risk_los_ziehung). Gegen PostgreSQL mit echter
// App-Rolle und dem produktiven EvidenceService belegt:
//  (1) Das Audit-Ereignis risk.los.gezogen legt im selben INSERT genau eine
//      Zeile an (Trigger), andere Aktionen und unvollständige Nachweise nicht;
//      die Listenabfrage der App (neueste zuerst) liest sie.
//  (2) RLS: ein fremder Tenant sieht die Ziehung nicht und kann keine für einen
//      anderen Tenant anlegen.
//  (3) Guard: ohne passendes Audit-Ereignis (fehlend, abweichend, fremder
//      Tenant) keine Zeile, auch nicht für Owner und Superuser.
//  (4) Unveränderlich: UPDATE, DELETE und TRUNCATE scheitern für App, Owner und
//      Superuser.
//  (5) Altbestand: Der Backfill der Migration übernimmt Ereignisse, die ohne
//      Trigger entstanden sind, verlustfrei und idempotent; seine Zählprüfung
//      besteht (in einer zurückgerollten Transaktion).
// Die Tenants behalten ihre append-only Audit-Zeilen.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { dbAbgewiesen } from '../testing/db-fehler';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('risk_los_ziehung braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const MIGRATION = readFileSync(
  new URL('../../prisma/migrations/20261012100000_risk_los_ziehung/migration.sql', import.meta.url),
  'utf8',
);
const backfillStart = MIGRATION.indexOf('INSERT INTO public."risk_los_ziehung"');
const BACKFILL = MIGRATION.slice(backfillStart, MIGRATION.indexOf(';', backfillStart) + 1);
const checkStart = MIGRATION.indexOf('DO $risk_los_ziehung_backfill$');
const COUNT_CHECK = MIGRATION.slice(
  checkStart,
  MIGRATION.indexOf('$risk_los_ziehung_backfill$;', checkStart) +
    '$risk_los_ziehung_backfill$;'.length,
);

const superuser = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});
const ownerUrl = (() => {
  if (process.env['DATABASE_OWNER_URL']) return process.env['DATABASE_OWNER_URL'];
  const url = new URL(optionalDatabaseUrl(process.env['DATABASE_URL']));
  url.username = 'taxtronik_owner';
  url.password = 'taxtronik_owner';
  return url.toString();
})();
const owner = new PrismaClient({ adapter: createPostgresAdapter(ownerUrl) });

let evidence: { record(tx: TxClient, event: object): Promise<{ id: bigint }> };
let tenantA = '';
let tenantB = '';
let staffA = '';
let staffB = '';

const nachweis = (commitment: string) => ({
  protokoll_version: 1,
  gezogen_am: '2026-10-12T08:00:00Z',
  rahmen: { commitment, n: 3 },
  k: 2,
  stichprobe: ['a1', 'c3'],
  entropie: { quelle_klasse: 'csprng', backend: 'csprng' },
  ableitung: { extraktor: 'sha256-vn', drbg: 'hmac-drbg-sha256' },
});

function inTenant<T>(tenantId: string, staffId: string, fn: (tx: TxClient) => Promise<T>) {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
      set_config('app.current_actor_type', 'STAFF', true),
      set_config('app.current_actor_id', ${staffId}, true)`;
    return fn(tx);
  });
}

async function recordLos(
  tenantId: string,
  staffId: string,
  after: object,
  action = 'risk.los.gezogen',
) {
  return inTenant(tenantId, staffId, (tx) =>
    evidence.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action,
      resourceType: 'quantenlos',
      resourceId: randomUUID(),
      after,
    }),
  );
}

async function tenantWithStaff(label: string): Promise<[string, string]> {
  const tenantId = (
    await superuser.tenant.create({
      data: { slug: `los-ziehung-${label}-${randomUUID()}`, name: `Los Ziehung ${label}` },
    })
  ).id;
  const staffId = (
    await superuser.staffUser.create({
      data: {
        tenantId,
        email: `los-ziehung-${label}-${randomUUID()}@example.test`,
        fullName: `Los ${label}`,
        passwordHash: 'x',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  return [tenantId, staffId];
}

beforeAll(async () => {
  const evidencePath = new URL('../../../evidence/src/service.ts', import.meta.url).href;
  const { EvidenceService } = await import(evidencePath);
  evidence = new EvidenceService({});
  [tenantA, staffA] = await tenantWithStaff('a');
  [tenantB, staffB] = await tenantWithStaff('b');
});

afterAll(async () => {
  await Promise.all([superuser.$disconnect(), app.$disconnect(), owner.$disconnect()]);
});

const ROLLBACK = new Error('rollback');

describeWithDatabase('TCMS-SAMPLE-PROOF-001: risk_los_ziehung (Welle 15, P-11)', () => {
  it('bildet jedes Audit-Ereignis risk.los.gezogen im selben INSERT ab, sonst nichts', async () => {
    const after = {
      nachweis: nachweis(`commit-${randomUUID()}`),
      rahmen: ['a1', 'b2', 'c3'],
      zeitraum: { von: '2026-05-01', bis: '2026-05-31' },
      rahmenTyp: 'subsumtion',
      reviewAufgaben: ['rem-1'],
      attemptId: randomUUID(),
    };
    const event = await recordLos(tenantA, staffA, after);
    const older = await recordLos(tenantA, staffA, {
      nachweis: nachweis(`commit-${randomUUID()}`),
      rahmen: ['1', '2', '3'],
      zeitraum: null,
      rahmenTyp: 'audit',
      jobId: 'ibm-job-1',
    });
    const withoutProof = await recordLos(tenantA, staffA, { rahmen: ['a1'] });
    const otherAction = await recordLos(tenantA, staffA, after, 'risk.los.beantragt');

    const rows = await inTenant(tenantA, staffA, (tx) =>
      // Dieselbe Abfrage wie listLosZiehungen (apps/web/src/server/risk/los.ts).
      tx.riskLosZiehung.findMany({ orderBy: { auditLogId: 'desc' }, take: 10 }),
    );
    expect(rows.map((row) => row.auditLogId)).toEqual([older.id, event.id]);
    expect(rows[1]).toMatchObject({
      tenantId: tenantA,
      commitment: after.nachweis.rahmen.commitment,
      rahmenTyp: 'subsumtion',
      nachweis: after.nachweis,
      rahmen: after.rahmen,
      zeitraum: after.zeitraum,
      reviewAufgaben: ['rem-1'],
      attemptId: after.attemptId,
      jobId: null,
    });
    expect(rows[0]).toMatchObject({ rahmenTyp: 'audit', zeitraum: null, reviewAufgaben: [] });
    expect(rows[0]!.jobId).toBe('ibm-job-1');
    const audit = await superuser.auditLog.findUniqueOrThrow({ where: { id: event.id } });
    expect(rows[1]!.auditOccurredAt).toEqual(audit.occurredAt);

    const unprojected = await superuser.riskLosZiehung.count({
      where: { auditLogId: { in: [withoutProof.id, otherAction.id] } },
    });
    expect(unprojected).toBe(0);

    // (2) RLS: Tenant B sieht keine Ziehung von A.
    const foreign = await inTenant(tenantB, staffB, (tx) =>
      tx.riskLosZiehung.findMany({ where: { auditLogId: event.id } }),
    );
    expect(foreign).toEqual([]);
  });

  it('verlangt für jede Zeile das passende Audit-Ereignis desselben Tenants', async () => {
    const after = { nachweis: nachweis(`commit-${randomUUID()}`), rahmen: ['x', 'y', 'z'] };
    const event = await recordLos(tenantA, staffA, after);
    const projected = await superuser.riskLosZiehung.findUniqueOrThrow({
      where: { auditLogId: event.id },
    });
    const { createdAt: _createdAt, ...row } = projected;
    void _createdAt;
    const event2 = await recordLos(tenantA, staffA, { rahmen: ['ohne-nachweis'] });

    // Ohne passendes Audit-Ereignis (Ereignis ohne Nachweis), mit abweichendem
    // Inhalt oder für einen fremden Tenant: Guard bzw. RLS lehnen ab.
    const attempts = [
      { ...row, auditLogId: event2.id },
      { ...row, auditLogId: event2.id, commitment: 'gefälscht' },
      { ...row, auditLogId: 999_999_999_999n },
    ];
    for (const data of attempts) {
      await dbAbgewiesen(
        inTenant(tenantA, staffA, (tx) => tx.riskLosZiehung.create({ data: data as never })),
        /bildet kein Audit-Ereignis risk\.los\.gezogen ab/,
      );
      await dbAbgewiesen(
        superuser.riskLosZiehung.create({ data: data as never }),
        /bildet kein Audit-Ereignis/,
      );
    }
    // Fremder Tenant: RLS WITH CHECK der App-Rolle, Guard für BYPASSRLS-Rollen.
    await dbAbgewiesen(
      inTenant(tenantB, staffB, (tx) =>
        tx.riskLosZiehung.create({ data: { ...row, auditLogId: event2.id } as never }),
      ),
      /row-level security|bildet kein Audit-Ereignis/,
    );
    await dbAbgewiesen(
      owner.riskLosZiehung.create({
        data: { ...row, auditLogId: event2.id, tenantId: tenantB } as never,
      }),
      /bildet kein Audit-Ereignis/,
    );
  });

  it('ist unveränderlich für App, Owner und Superuser', async () => {
    const event = await recordLos(tenantA, staffA, {
      nachweis: nachweis(`commit-${randomUUID()}`),
      rahmen: ['p', 'q', 'r'],
    });
    const statements = [
      `UPDATE risk_los_ziehung SET commitment = 'x' WHERE audit_log_id = ${event.id}`,
      `DELETE FROM risk_los_ziehung WHERE audit_log_id = ${event.id}`,
      'TRUNCATE risk_los_ziehung',
    ];
    for (const statement of statements) {
      await dbAbgewiesen(
        inTenant(tenantA, staffA, (tx) => tx.$executeRawUnsafe(statement)),
        /permission denied|append-only/,
      );
      await dbAbgewiesen(owner.$executeRawUnsafe(statement), /permission denied|append-only/);
      await dbAbgewiesen(superuser.$executeRawUnsafe(statement), /append-only/);
    }
    await expect(superuser.riskLosZiehung.count({ where: { auditLogId: event.id } })).resolves.toBe(
      1,
    );
  });

  it('übernimmt den Altbestand verlustfrei und idempotent (Backfill der Migration)', async () => {
    expect(BACKFILL).toContain('ON CONFLICT ("audit_log_id") DO NOTHING');
    expect(COUNT_CHECK).toContain('RAISE EXCEPTION');
    await expect(
      superuser.$transaction(
        async (tx) => {
          // Altbestand: Ereignisse wie vor der Migration, ohne Projektionstrigger.
          await tx.$executeRawUnsafe(
            'ALTER TABLE audit_log DISABLE TRIGGER risk_los_ziehung_projection',
          );
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantB}, true),
            set_config('app.current_actor_type', 'STAFF', true),
            set_config('app.current_actor_id', ${staffB}, true)`;
          const legacy = [];
          for (const after of [
            { nachweis: nachweis(`legacy-${randomUUID()}`), rahmen: ['1', '2'], zeitraum: null },
            {
              nachweis: nachweis(`legacy-${randomUUID()}`),
              rahmen: ['a1', 'b2', 'c3'],
              zeitraum: { von: '2026-01-01', bis: '2026-01-31' },
              rahmenTyp: 'audit',
              reviewAufgaben: [],
              jobId: 'legacy-job',
            },
          ]) {
            legacy.push(
              await evidence.record(tx, {
                tenantId: tenantB,
                actorType: 'STAFF',
                actorId: staffB,
                action: 'risk.los.gezogen',
                resourceType: 'quantenlos',
                resourceId: randomUUID(),
                after,
              }),
            );
          }
          await tx.$executeRawUnsafe(
            'ALTER TABLE audit_log ENABLE TRIGGER risk_los_ziehung_projection',
          );
          const ids = legacy.map((event) => event.id);
          await expect(
            tx.riskLosZiehung.count({ where: { auditLogId: { in: ids } } }),
          ).resolves.toBe(0);

          const first = await tx.$executeRawUnsafe(BACKFILL);
          expect(first).toBe(2);
          await tx.$executeRawUnsafe(COUNT_CHECK);
          expect(await tx.$executeRawUnsafe(BACKFILL)).toBe(0);
          await tx.$executeRawUnsafe(COUNT_CHECK);

          const rows = await tx.riskLosZiehung.findMany({
            where: { auditLogId: { in: ids } },
            orderBy: { auditLogId: 'asc' },
          });
          const audits = await tx.auditLog.findMany({
            where: { id: { in: ids } },
            orderBy: { id: 'asc' },
          });
          expect(rows.map((row) => [row.tenantId, row.nachweis, row.rahmen])).toEqual(
            audits.map((audit) => {
              const after = audit.after as { nachweis: unknown; rahmen: unknown };
              return [tenantB, after.nachweis, after.rahmen];
            }),
          );
          expect(rows[1]).toMatchObject({ rahmenTyp: 'audit', jobId: 'legacy-job' });
          throw ROLLBACK;
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBe(ROLLBACK);
  });
});
