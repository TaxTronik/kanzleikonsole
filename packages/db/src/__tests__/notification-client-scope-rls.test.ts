// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Notification-Scope-RLS-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId: string;
let clientId: string;
let staffAId: string;
let staffBId: string;
let noticeId: string;

async function asStaff<T>(staffId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${staffId}, true),
        set_config('app.current_actor_type', 'STAFF', true)
    `;
    return work(tx);
  });
}

beforeAll(async () => {
  const suffix = Date.now();
  tenantId = (
    await owner.tenant.create({
      data: { slug: `notification-scope-${suffix}`, name: 'Notification-Scope-RLS' },
    })
  ).id;
  const [staffA, staffB] = await Promise.all([
    owner.staffUser.create({
      data: {
        tenantId,
        email: `notification-a-${suffix}@test.local`,
        fullName: 'Notification A',
        passwordHash: 'x',
        active: true,
      },
    }),
    owner.staffUser.create({
      data: {
        tenantId,
        email: `notification-b-${suffix}@test.local`,
        fullName: 'Notification B',
        passwordHash: 'x',
        active: true,
      },
    }),
  ]);
  staffAId = staffA.id;
  staffBId = staffB.id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Notification-Mandant' },
    })
  ).id;
  noticeId = (
    await owner.taxNotice.create({
      data: {
        tenantId,
        clientId,
        kind: 'EST',
        period: `notification-${suffix}`,
        noticeDate: new Date('2026-08-01T00:00:00.000Z'),
        createdByStaff: staffAId,
      },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('Notification-Mandantenscope und Empfänger-RLS', () => {
  // Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
  it('leitet den Mandanten aus der Fachressource ab und lehnt unbekannte Typen fail-closed ab', async () => {
    const scoped = await owner.notification.create({
      data: {
        tenantId,
        staffId: staffAId,
        kind: 'TAX_NOTICE_APPEAL_REMINDER',
        title: 'Abgeleiteter Scope',
        resourceType: 'tax_notice',
        resourceId: noticeId,
      },
    });
    expect(scoped.clientId).toBe(clientId);
    await owner.notification.delete({ where: { id: scoped.id } });

    await expect(
      owner.notification.create({
        data: {
          tenantId,
          clientId,
          staffId: staffAId,
          kind: 'SYSTEM_MAIL_FAILED',
          title: 'Nicht klassifizierter Fachtyp',
          resourceType: 'future_client_case',
          resourceId: noticeId,
        },
      }),
    ).rejects.toThrow(/Unklassifizierter Notification-Ressourcentyp/i);

    await expect(
      owner.notification.create({
        data: {
          tenantId,
          staffId: staffAId,
          kind: 'SYSTEM_MAIL_FAILED',
          title: 'Nicht klassifizierter vermeintlicher Globaltyp',
          resourceType: 'future_global_case',
          resourceId: 'opaque',
        },
      }),
    ).rejects.toThrow(/Unklassifizierter Notification-Ressourcentyp/i);

    await expect(
      owner.notification.create({
        data: {
          tenantId,
          clientId,
          staffId: staffAId,
          kind: 'SYSTEM_BACKUP_FAILED',
          title: 'Globaltyp mit gefälschtem Mandantenscope',
          resourceType: 'backup_drill',
          resourceId: 'object-key',
        },
      }),
    ).rejects.toThrow(/Foreign key constraint|client_id widerspricht/i);
  });

  it('zeigt gezielte Hinweise nur dem Empfänger und globale Hinweise allen aktiven Mitarbeitern', async () => {
    await owner.notification.createMany({
      data: [
        {
          tenantId,
          staffId: staffAId,
          kind: 'TAX_NOTICE_APPEAL_REMINDER',
          title: 'Mandant A',
          resourceType: 'tax_notice',
          resourceId: noticeId,
        },
        {
          tenantId,
          staffId: staffBId,
          kind: 'TAX_NOTICE_APPEAL_REMINDER',
          title: 'Mandant B',
          resourceType: 'tax_notice',
          resourceId: noticeId,
        },
        {
          tenantId,
          staffId: null,
          kind: 'TAX_NOTICE_APPEAL_REMINDER',
          title: 'Mandant global',
          resourceType: 'tax_notice',
          resourceId: noticeId,
        },
        {
          tenantId,
          staffId: staffAId,
          kind: 'SYSTEM_BACKUP_FAILED',
          title: 'Kanzlei A',
          resourceType: 'backup_drill',
          resourceId: 'backup-a',
        },
        {
          tenantId,
          staffId: null,
          kind: 'SYSTEM_BACKUP_FAILED',
          title: 'Kanzlei global',
        },
      ],
    });

    const titlesA = await asStaff(staffAId, async (tx) =>
      (await tx.notification.findMany({ select: { title: true } })).map((row) => row.title),
    );
    expect(titlesA).toEqual(
      expect.arrayContaining(['Mandant A', 'Mandant global', 'Kanzlei A', 'Kanzlei global']),
    );
    expect(titlesA).not.toContain('Mandant B');

    const titlesB = await asStaff(staffBId, async (tx) =>
      (await tx.notification.findMany({ select: { title: true } })).map((row) => row.title),
    );
    expect(titlesB).toEqual(
      expect.arrayContaining(['Mandant B', 'Mandant global', 'Kanzlei global']),
    );
    expect(titlesB).not.toContain('Mandant A');
    expect(titlesB).not.toContain('Kanzlei A');
  });

  it('entzieht nach Vertraulich-Markierung sofort Lesen, Aktualisieren und Löschen', async () => {
    const targetB = await owner.notification.create({
      data: {
        tenantId,
        staffId: staffBId,
        kind: 'REQUEST_RESPONDED',
        title: 'Später entzogen',
        resourceType: 'tax_notice',
        resourceId: noticeId,
      },
    });
    await owner.clientResponsibility.create({
      data: { tenantId, clientId, staffId: staffAId, role: 'HAUPTBEARBEITER' },
    });
    await owner.client.update({ where: { id: clientId }, data: { vertraulich: true } });

    const visibleToB = await asStaff(staffBId, (tx) =>
      tx.notification.findMany({ where: { id: targetB.id }, select: { id: true } }),
    );
    expect(visibleToB).toEqual([]);
    await expect(
      asStaff(staffBId, (tx) =>
        tx.notification.update({ where: { id: targetB.id }, data: { readAt: new Date() } }),
      ),
    ).rejects.toThrow();
    await expect(
      asStaff(staffBId, (tx) => tx.notification.delete({ where: { id: targetB.id } })),
    ).rejects.toThrow();

    const targetA = await owner.notification.create({
      data: {
        tenantId,
        staffId: staffAId,
        kind: 'SYSTEM_MAIL_FAILED',
        title: 'Empfänger unveränderlich',
        resourceType: 'tax_notice',
        resourceId: noticeId,
      },
    });
    await expect(
      asStaff(staffAId, (tx) =>
        tx.notification.update({ where: { id: targetA.id }, data: { staffId: staffBId } }),
      ),
    ).rejects.toThrow(/Scope und Ressourcenlink sind unveränderlich/i);
  });
});
