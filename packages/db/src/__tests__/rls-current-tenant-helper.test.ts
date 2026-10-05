// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: REMINDER-TICKET-001
//
// Review-Finding D-04: Alle Policies lesen den Tenant über app.current_tenant_id().
// Ein auf der Pool-Verbindung zurückgesetzter Kontext ('') ergibt keine Zeilen
// statt eines Cast-Fehlers; die Helfer sind PARALLEL SAFE und liefern auch in
// einem parallelen Worker den Kontext des Leaders.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('RLS-Kontexttest braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

// Die sechs Policies aus Review-Finding D-04.
const TABLES = [
  'email_template',
  'workflow_item_comment',
  'workflow_instance_member',
  'client_reminder',
  'pending_binder',
  'client_reminder_note',
] as const;

let tenantId: string;

async function countAs(setting: string | null, run?: (tx: TxClient) => Promise<void>) {
  return app.$transaction(async (tx) => {
    if (setting !== null) {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${setting}, true)`;
    }
    if (run) await run(tx as TxClient);
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM public."${table}"`,
      );
      counts[table] = Number(rows[0]?.n ?? -1);
    }
    return counts;
  });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantId = (await owner.tenant.create({ data: { name: 'D-04', slug: `d04-${seed}` } })).id;
  const staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `d04-${seed}@example.test`,
        fullName: 'D-04',
        passwordHash: 'synthetic',
      },
    })
  ).id;
  const clientId = (
    await owner.client.create({ data: { tenantId, kind: 'NATPERS', name: 'D-04-Mandant' } })
  ).id;
  await owner.emailTemplate.create({
    data: { tenantId, name: 'Vorlage', subject: 'Betreff', bodyMd: 'Text' },
  });
  const instance = await owner.workflowInstance.create({
    data: { tenantId, clientId, name: 'Workflow', startedByStaff: staffId },
  });
  const item = await owner.workflowItem.create({
    data: { instanceId: instance.id, position: 1, title: 'Schritt' },
  });
  await owner.workflowItemComment.create({
    data: { itemId: item.id, authorStaffId: staffId, authorName: 'D-04', body: 'Kommentar' },
  });
  await owner.workflowInstanceMember.create({
    data: { instanceId: instance.id, staffId, addedBy: staffId },
  });
  const reminder = await owner.clientReminder.create({
    data: { tenantId, dueDate: new Date('2026-12-01'), subject: 'Frist', createdByStaff: staffId },
  });
  await owner.clientReminderNote.create({
    data: { tenantId, reminderId: reminder.id, staffId, body: 'Notiz' },
  });
  await owner.pendingBinder.create({
    data: { tenantId, clientId, label: 'Ordner', createdByStaff: staffId },
  });
});

afterAll(async () => {
  try {
    if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  } finally {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
});

describeWithDatabase('RLS-Tenantkontext über app.current_tenant_id()', () => {
  it('keine Policy liest app.current_tenant_id direkt per current_setting', async () => {
    const rows = await owner.$queryRaw<Array<{ policy: string }>>`
      SELECT c.relname || '.' || p.polname AS policy
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
       WHERE coalesce(pg_get_expr(p.polqual, p.polrelid), '') ILIKE '%current_setting%app.current_tenant_id%'
          OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ILIKE '%current_setting%app.current_tenant_id%'
    `;
    expect(rows).toEqual([]);
  });

  it('zeigt mit gültigem Kontext dieselben Zeilen wie bisher', async () => {
    const counts = await countAs(tenantId);
    for (const table of TABLES) expect(counts[table], table).toBe(1);
  });

  it('liefert mit zurückgesetztem oder fehlendem Kontext keine Zeile statt eines Fehlers', async () => {
    // '' entspricht einer Pool-Verbindung nach einer früheren set_config(..., true).
    const reset = await countAs('');
    const missing = await countAs(null);
    for (const table of TABLES) {
      expect(reset[table], table).toBe(0);
      expect(missing[table], table).toBe(0);
    }
  });

  it('blockiert Schreibzugriffe ohne Kontext über die Policy, nicht über einen Cast-Fehler', async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id', '', true)`;
        await tx.$executeRaw`
          INSERT INTO public.email_template (tenant_id, name, subject, body_md, updated_at)
          VALUES (${tenantId}::uuid, 'ohne Kontext', 's', 'b', now())
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('erklärt die Kontext-Helfer PARALLEL SAFE und lässt den Rest unverändert', async () => {
    const rows = await owner.$queryRaw<
      Array<{ name: string; parallel: string; volatile: string; secdef: boolean; config: string[] }>
    >`
      SELECT p.proname::text AS name, p.proparallel::text AS parallel, p.provolatile::text AS volatile,
             p.prosecdef AS secdef, p.proconfig AS config
        FROM pg_proc p
       WHERE p.oid IN ('app.current_tenant_id()'::regprocedure,
                       'app.current_actor_id()'::regprocedure,
                       'app.current_actor_type()'::regprocedure)
       ORDER BY p.proname
    `;
    expect(rows).toEqual(
      ['current_actor_id', 'current_actor_type', 'current_tenant_id'].map((name) => ({
        name,
        parallel: 's',
        volatile: 's',
        secdef: true,
        config: ['search_path=pg_catalog'],
      })),
    );
  });

  it('liefert den Kontext des Leaders auch in einem parallelen Worker', async () => {
    const counts = await countAs(tenantId, async (tx) => {
      // Erzwingt die Ausführung im Worker, sobald der Plan parallel sicher ist.
      await tx.$executeRawUnsafe('SET LOCAL debug_parallel_query = on');
      const plan = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        'EXPLAIN (COSTS OFF) SELECT count(*) FROM public.email_template',
      );
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('Gather');
    });
    expect(counts['email_template']).toBe(1);
  });
});
