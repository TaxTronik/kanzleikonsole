// Fachkatalog: MAIL-OUTBOX-001
// =============================================================================
// Welle 15: Mandanten-Mails bei Terminänderung und -absage gegen PostgreSQL.
//
// Belegt mit echter Outbox, echter Aktualitätsprüfung und echtem Worker-Kern:
// Aufträge entstehen unter der App-Rolle im Kanzleikontext (wie die Termin-
// Action) mit gemeinsamem created_at je Auslösung und angekündigtem Stand;
// nach erneuter Änderung geht nur die Mail mit dem aktuellen Stand hinaus, nach
// einer Absage keine Änderungsmail mehr, die Absagemail schon. Dazu die
// System-Vorlagen der Migration 20261012110100: je Kanzlei einmal, idempotent,
// ohne Konflikt mit einer gleichnamigen eigenen Vorlage. Versand (SMTP) ist
// eine Attrappe. Nur mit Opt-in (WORKER_DB_TEST=1 bzw. DB_TESTS=1).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenantContext } from '@taxtronik/db';
import { enqueueDirectMailTx } from '@taxtronik/mail/outbox';

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

vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prismaOwner } from '../../prisma-owner';
import { withWorkerTenantContext } from '../../tenant-context';
import { notify } from '../../notify';
import { processMailOutbox, type MailOutboxDeliveryDeps } from '../mail-outbox';

const describeDb = enabled ? describe : describe.skip;

const templateMigration = readFileSync(
  new URL(
    '../../../../../packages/db/prisma/migrations/20261012110100_appointment_change_mail_templates/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
/**
 * Der INSERT der Migration (zwischen BEGIN und COMMIT), auf die Tenants dieses
 * Tests begrenzt, damit parallele DB-Suiten unberührt bleiben.
 */
const templateInsert = templateMigration
  .slice(templateMigration.indexOf('INSERT INTO'), templateMigration.lastIndexOf('COMMIT;'))
  .trimEnd()
  .replace(/;$/, ' AND t."id" = ANY($1::uuid[]);');

describeDb('Welle 15 Terminmitteilungen über die Mail-Outbox (PostgreSQL)', () => {
  let tenantId = '';
  let clientId = '';
  let staffId = '';
  let appointmentId = '';
  const sendTemplateMail = vi.fn();
  const deps: MailOutboxDeliveryDeps = {
    db: prismaOwner,
    runAtomic: (tenant, fn) => withWorkerTenantContext(tenant, fn),
    sendTemplateMail,
    notifyClientContacts: vi.fn(),
    loadAttachment: vi.fn(),
    notifyStaff: (tx, input) => notify(tx, input),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const FIRST = {
    startsAt: new Date('2030-10-21T12:00:00.000Z'),
    endsAt: new Date('2030-10-21T13:00:00.000Z'),
  };
  const SECOND = {
    startsAt: new Date('2030-10-22T08:00:00.000Z'),
    endsAt: new Date('2030-10-22T09:00:00.000Z'),
  };

  /** Wie die Termin-Action: ändert den Termin und legt im selben Commit die Mails an. */
  async function changeAndNotify(
    when: { startsAt: Date; endsAt: Date },
    recipients: readonly string[],
  ): Promise<string[]> {
    const createdAt = new Date();
    return withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
      await tx.appointment.update({ where: { id: appointmentId }, data: when });
      const ids: string[] = [];
      for (const to of recipients) {
        ids.push(
          await enqueueDirectMailTx(
            tx,
            {
              tenantId,
              clientId,
              purpose: 'appointment-changed',
              resource: { type: 'appointment', id: appointmentId },
              staffHref: '/staff/calendar',
              createdAt,
            },
            {
              slug: 'appointment-changed',
              to,
              vars: { appointment: { title: 'Jahresgespräch' } },
              fallback: { subject: 'Terminänderung', bodyMd: '{{appointment.title}}' },
              relevance: {
                appointment: {
                  startsAt: when.startsAt.toISOString(),
                  endsAt: when.endsAt.toISOString(),
                  title: 'Jahresgespräch',
                  location: null,
                },
              },
            },
          ),
        );
      }
      return ids;
    });
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await prismaOwner.tenant.create({ data: { slug: `w15-appt-${suffix}`, name: 'W15 Termine' } })
    ).id;
    clientId = (
      await prismaOwner.client.create({
        data: { tenantId, name: 'W15 Mandant', kind: 'NATPERS' },
      })
    ).id;
    staffId = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `w15-appt-${suffix}@example.test`,
          fullName: 'W15 Kanzlei',
          passwordHash: 'synthetic',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) await prismaOwner.tenant.delete({ where: { id: tenantId } });
    await prismaOwner.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    sendTemplateMail.mockResolvedValue({
      ok: true,
      sentViaTemplate: false,
      uncertainFailure: false,
    });
    await prismaOwner.mailOutbox.deleteMany({ where: { tenantId } });
    await prismaOwner.appointment.deleteMany({ where: { tenantId } });
    appointmentId = (
      await prismaOwner.appointment.create({
        data: {
          tenantId,
          ownerStaffId: staffId,
          createdByStaff: staffId,
          clientId,
          status: 'CONFIRMED',
          title: 'Jahresgespräch',
          startsAt: new Date('2030-10-20T08:00:00.000Z'),
          endsAt: new Date('2030-10-20T09:00:00.000Z'),
        },
      })
    ).id;
  });

  it('sendet nach zwei Änderungen nur die Mails mit dem aktuellen Stand', async () => {
    const first = await changeAndNotify(FIRST, ['a@example.test', 'b@example.test']);
    const second = await changeAndNotify(SECOND, ['a@example.test', 'b@example.test']);

    // Eine Auslösung = ein gemeinsamer created_at (Zustellstatus zeigt die jüngste).
    const rows = await prismaOwner.mailOutbox.findMany({
      where: { tenantId },
      select: { id: true, createdAt: true },
    });
    const createdAt = new Map(rows.map((row) => [row.id, row.createdAt.getTime()]));
    expect(createdAt.get(first[0]!)).toBe(createdAt.get(first[1]!));
    expect(createdAt.get(second[0]!)).toBe(createdAt.get(second[1]!));
    expect(createdAt.get(second[0]!)).toBeGreaterThanOrEqual(createdAt.get(first[0]!)!);

    const stats = await processMailOutbox(deps, { tenantId });

    expect(stats).toMatchObject({ skipped: 2, processed: 2, providerAccepted: 2 });
    for (const id of first) {
      expect(await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'SKIPPED',
        payload: {},
        lastError: 'Nicht versendet: Der Termin wurde seitdem erneut geändert.',
      });
    }
    for (const id of second) {
      expect((await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } })).status).toBe(
        'PROVIDER_ACCEPTED',
      );
    }
    expect(sendTemplateMail).toHaveBeenCalledTimes(2);
  });

  it('verwirft nach einer Absage die Änderungsmail und sendet die Absagemail', async () => {
    const [changed] = await changeAndNotify(FIRST, ['a@example.test']);
    const cancelled = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        await tx.appointment.update({
          where: { id: appointmentId },
          data: { status: 'CANCELLED' },
        });
        return enqueueDirectMailTx(
          tx,
          {
            tenantId,
            clientId,
            purpose: 'appointment-cancelled',
            resource: { type: 'appointment', id: appointmentId },
            staffHref: '/staff/calendar',
            createdAt: new Date(),
          },
          {
            slug: 'appointment-cancelled',
            to: 'a@example.test',
            vars: {},
            fallback: { subject: 'Terminabsage', bodyMd: 'Abgesagt.' },
          },
        );
      },
    );

    const stats = await processMailOutbox(deps, { tenantId });

    expect(stats).toMatchObject({ skipped: 1, providerAccepted: 1 });
    expect(
      await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id: changed! } }),
    ).toMatchObject({
      status: 'SKIPPED',
      lastError: 'Nicht versendet: Der Termin wurde inzwischen abgesagt.',
    });
    expect(
      (await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id: cancelled } })).status,
    ).toBe('PROVIDER_ACCEPTED');
    expect(sendTemplateMail).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'appointment-cancelled', to: 'a@example.test' }),
    );
  });

  it('seedet die System-Vorlagen je Kanzlei einmal und ohne Namenskonflikt', async () => {
    const otherTenant = (
      await prismaOwner.tenant.create({
        data: { slug: `w15-tpl-${randomUUID()}`, name: 'W15 Vorlagenkonflikt' },
      })
    ).id;
    try {
      // Eigene Vorlage mit dem vorgesehenen Namen: kein Unique-Fehler, keine Systemvorlage.
      await prismaOwner.emailTemplate.create({
        data: {
          tenantId: otherTenant,
          name: 'Termin geändert (Kanzlei)',
          subject: 'Eigene Vorlage',
          bodyMd: 'Text',
        },
      });
      const scope = [tenantId, otherTenant];
      await prismaOwner.$transaction(async (tx) => {
        expect(await tx.$executeRawUnsafe(templateInsert, scope)).toBe(3);
        // Idempotent: ein zweiter Lauf legt nichts an.
        expect(await tx.$executeRawUnsafe(templateInsert, scope)).toBe(0);
      });
      const seeded = await prismaOwner.emailTemplate.findMany({
        where: { tenantId: { in: [tenantId, otherTenant] }, slug: { not: null } },
        select: { tenantId: true, slug: true, active: true, category: true },
        orderBy: [{ tenantId: 'asc' }, { slug: 'asc' }],
      });
      expect(seeded.filter((row) => row.tenantId === tenantId)).toEqual([
        { tenantId, slug: 'appointment-cancelled', active: true, category: 'System' },
        { tenantId, slug: 'appointment-changed', active: true, category: 'System' },
      ]);
      expect(seeded.filter((row) => row.tenantId === otherTenant)).toEqual([
        {
          tenantId: otherTenant,
          slug: 'appointment-cancelled',
          active: true,
          category: 'System',
        },
      ]);
    } finally {
      await prismaOwner.tenant.delete({ where: { id: otherTenant } });
      await prismaOwner.emailTemplate.deleteMany({ where: { tenantId, slug: { not: null } } });
    }
  });
});
