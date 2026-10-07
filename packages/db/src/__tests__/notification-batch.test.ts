// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
// Fachkatalog: AUDIT-ARCHIVE-001, DSGVO-OPERATIONAL-RETENTION-001 (B14-Rückstandsalarm)
//
// R-11: upsertNotificationsTx (gebündelter Worker-Pfad hinter notify()) wirkt je
// Eintrag wie nacheinander ausgeführte upsertNotificationTx-Aufrufe: ungelesene
// Hinweise desselben Schlüssels werden aktualisiert, gelesene bleiben unberührt
// und bekommen einen neuen, ein nicht gesetzter Mandantenscope gleicht jeden
// Scope ab, Texte laufen durch den Sanitizer. Bewusste Abweichung: ein Konflikt
// mit dem Tages-Dedupe-Index wird übersprungen, statt die Transaktion
// abzubrechen. insertNotificationsTx (Tages-Erinnerungen) legt je Tag einmal an.
// B14: Die Rückstandshinweise der Wartungsjobs fallen unter die Tages-Dedupe-
// Indizes (20261007141100): je Empfänger und UTC-Tag höchstens eine Neuanlage.
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import {
  insertNotificationsTx,
  upsertNotificationTx,
  upsertNotificationsTx,
  type NotificationUpsertInput,
} from '../notification';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Notification-Batchtest braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

type StaffKey = 'a' | 'b' | 'c';
interface Fixture {
  tenantId: string;
  clientId: string;
  staff: Record<StaffKey, string>;
}
const tenants: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const suffix = randomUUID();
  const tenantId = (
    await owner.tenant.create({
      data: { slug: `notify-batch-${label}-${suffix}`, name: `Notify ${label}` },
    })
  ).id;
  tenants.push(tenantId);
  const staff = {} as Record<StaffKey, string>;
  for (const key of ['a', 'b', 'c'] as const) {
    staff[key] = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `${key}-${suffix}@example.test`,
          fullName: `Synthetic ${key}`,
          passwordHash: 'x',
          roles: { create: [{ role: 'ADMIN' }] },
        },
      })
    ).id;
  }
  const clientId = (
    await owner.client.create({ data: { tenantId, name: 'Synthetic client', kind: 'JURPERS' } })
  ).id;
  return { tenantId, clientId, staff };
}

/** Wie der Worker: Owner-Transaktion mit Tenant- und SYSTEM-Actor-Kontext. */
function asWorker<T>(tenantId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', '', true),
        set_config('app.current_actor_type', 'SYSTEM', true)
    `;
    return work(tx);
  });
}

async function seed(fixture: Fixture): Promise<void> {
  const { tenantId, clientId, staff } = fixture;
  await owner.notification.createMany({
    data: [
      {
        tenantId,
        staffId: staff.a,
        kind: 'SCREENING_REVIEW',
        title: 'alt a',
        resourceType: 'tenant',
        resourceId: tenantId,
      },
      {
        tenantId,
        staffId: staff.b,
        kind: 'SCREENING_REVIEW',
        title: 'alt b (gelesen)',
        resourceType: 'tenant',
        resourceId: tenantId,
        readAt: new Date(),
      },
      {
        tenantId,
        staffId: staff.c,
        kind: 'SCREENING_REVIEW',
        title: 'alt c',
        resourceType: 'client',
        resourceId: clientId,
      },
    ],
  });
}

function inputs(fixture: Fixture): NotificationUpsertInput[] {
  const { tenantId, clientId, staff } = fixture;
  const tenantNotice = {
    tenantId,
    kind: 'SCREENING_REVIEW' as const,
    href: '/staff/admin/screening',
    resourceType: 'tenant',
    resourceId: tenantId,
  };
  return [
    { ...tenantNotice, staffId: staff.a, title: 'neu <a>‮', body: 'Text <b>' },
    { ...tenantNotice, staffId: staff.b, title: 'neu b' },
    // Ohne clientId: gleicht die offene, mandantenbezogene Notification ab.
    {
      tenantId,
      staffId: staff.c,
      kind: 'SCREENING_REVIEW',
      title: 'neu c',
      href: `/staff/clients/${clientId}/screening`,
      resourceType: 'client',
      resourceId: clientId,
    },
    { ...tenantNotice, staffId: staff.c, clientId: null, title: 'neu c tenant' },
    {
      tenantId,
      kind: 'SYSTEM_BACKUP_FAILED',
      title: 'Restore-Test fehlgeschlagen',
      resourceType: 'backup_drill',
      resourceId: 'none',
    },
  ];
}

async function snapshot(fixture: Fixture) {
  const staffKey = new Map(Object.entries(fixture.staff).map(([key, id]) => [id, key]));
  const rows = await owner.notification.findMany({ where: { tenantId: fixture.tenantId } });
  return rows
    .map((row) => ({
      staff: row.staffId ? staffKey.get(row.staffId) : null,
      client: row.clientId === fixture.clientId ? 'client' : row.clientId,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href?.replace(fixture.clientId, '<client>') ?? null,
      resourceType: row.resourceType,
      resourceId:
        row.resourceId === fixture.tenantId
          ? 'tenant'
          : row.resourceId === fixture.clientId
            ? 'client'
            : row.resourceId,
      read: row.readAt !== null,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describeWithDatabase('R-11: gebündelter Notification-Pfad', () => {
  afterAll(async () => {
    for (const id of tenants) await owner.tenant.delete({ where: { id } });
    await owner.$disconnect();
  });

  it('ergibt denselben Bestand wie nacheinander ausgeführte Einzel-Upserts', async () => {
    const sequential = await createFixture('seq');
    const batched = await createFixture('batch');
    await seed(sequential);
    await seed(batched);

    await asWorker(sequential.tenantId, async (tx) => {
      for (const input of inputs(sequential)) await upsertNotificationTx(tx, input);
    });
    const result = await asWorker(batched.tenantId, (tx) =>
      upsertNotificationsTx(tx, inputs(batched)),
    );

    expect(result).toEqual({ created: 3, updated: 2 });
    const expected = await snapshot(sequential);
    expect(await snapshot(batched)).toEqual(expected);
    // Stichprobe unabhängig von der Implementierung: Sanitizer und gelesene Zeile.
    expect(expected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staff: 'a', title: 'neu ‹a>', body: 'Text ‹b>', read: false }),
        expect.objectContaining({ staff: 'b', title: 'alt b (gelesen)', read: true }),
        expect.objectContaining({ staff: 'b', title: 'neu b', read: false }),
        expect.objectContaining({ staff: 'c', client: 'client', title: 'neu c' }),
      ]),
    );
    expect(expected).toHaveLength(6);
  });

  it('überspringt einen Konflikt mit dem Tages-Dedupe-Index, statt abzubrechen', async () => {
    const fixture = await createFixture('daily');
    const notice: NotificationUpsertInput = {
      tenantId: fixture.tenantId,
      staffId: fixture.staff.a,
      kind: 'GWG_DELETION_DUE',
      title: 'GwG-Löschprüfung',
      href: '/staff/admin/gwg-retention',
      resourceType: 'tenant',
      resourceId: fixture.tenantId,
    };
    await owner.notification.create({ data: { ...notice, readAt: new Date() } });

    // Einzel-Upsert: keine ungelesene Zeile → INSERT → Unique-Verletzung.
    await expect(
      asWorker(fixture.tenantId, (tx) => upsertNotificationTx(tx, notice)),
    ).rejects.toThrow();
    await expect(
      asWorker(fixture.tenantId, async (tx) => {
        const result = await upsertNotificationsTx(tx, [notice]);
        // Die Transaktion bleibt nutzbar.
        await tx.$queryRaw`SELECT 1`;
        return result;
      }),
    ).resolves.toEqual({ created: 0, updated: 0 });
    expect(
      await owner.notification.count({
        where: { tenantId: fixture.tenantId, kind: 'GWG_DELETION_DUE' },
      }),
    ).toBe(1);
  });

  it('insertNotificationsTx legt Tages-Erinnerungen einmal je Tag sanitisiert an', async () => {
    const fixture = await createFixture('insert');
    const reminders: NotificationUpsertInput[] = (['b', 'c'] as const).map((key) => ({
      tenantId: fixture.tenantId,
      staffId: fixture.staff[key],
      kind: 'GWG_DELETION_DUE',
      title: `Erinnerung <${key}>`,
      resourceType: 'tenant',
      resourceId: fixture.tenantId,
    }));

    await expect(
      asWorker(fixture.tenantId, (tx) => insertNotificationsTx(tx, reminders)),
    ).resolves.toBe(2);
    await expect(
      asWorker(fixture.tenantId, (tx) => insertNotificationsTx(tx, reminders)),
    ).resolves.toBe(0);

    expect((await snapshot(fixture)).map((row) => row.title)).toEqual([
      'Erinnerung ‹b>',
      'Erinnerung ‹c>',
    ]);
  });

  it.each(['SYSTEM_AUDIT_ARCHIVE_BACKLOG', 'SYSTEM_STORAGE_CLEANUP_BACKLOG'] as const)(
    'B14: legt %s je Empfänger und UTC-Tag höchstens einmal neu an',
    async (kind) => {
      const fixture = await createFixture(`backlog-${kind.toLowerCase()}`);
      const notice: NotificationUpsertInput = {
        tenantId: fixture.tenantId,
        staffId: fixture.staff.a,
        kind,
        title: 'Wartungsrückstand',
        href: '/staff/admin/jobs',
        resourceType: 'tenant',
        resourceId: fixture.tenantId,
      };
      // Der Hinweis von gestern ist gelesen und zählt für heute nicht.
      await owner.notification.create({
        data: { ...notice, createdAt: new Date(Date.now() - 86_400_000), readAt: new Date() },
      });
      const upsert = () =>
        asWorker(fixture.tenantId, (tx) =>
          upsertNotificationsTx(tx, [{ ...notice, body: 'aktuelle Zahlen' }]),
        );

      await expect(upsert()).resolves.toEqual({ created: 1, updated: 0 });
      // Ungelesen: derselbe Hinweis wird aktualisiert, nicht dupliziert.
      await expect(upsert()).resolves.toEqual({ created: 0, updated: 1 });
      await owner.notification.updateMany({
        where: { tenantId: fixture.tenantId, kind, readAt: null },
        data: { readAt: new Date() },
      });
      // Heute gelesen: der Tages-Index lässt keine zweite Neuanlage zu.
      await expect(upsert()).resolves.toEqual({ created: 0, updated: 0 });
      // Ein anderer Empfänger ist ein eigener Schlüssel.
      await expect(
        asWorker(fixture.tenantId, (tx) =>
          upsertNotificationsTx(tx, [{ ...notice, staffId: fixture.staff.b }]),
        ),
      ).resolves.toEqual({ created: 1, updated: 0 });

      expect(
        await owner.notification.count({
          where: { tenantId: fixture.tenantId, staffId: fixture.staff.a, kind },
        }),
      ).toBe(2);
      await expect(
        owner.notification.create({ data: { ...notice, readAt: new Date() } }),
      ).rejects.toThrow();
    },
  );
});
