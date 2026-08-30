import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { withTenantContext } from '../tenant-context';
import { prisma as appPrisma } from '../client';

// Fachkatalog: TAX-CONTROL-STATUS-001

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Tagesabschluss-DB-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let staffId: string;

const snapshotIds = {
  future: '00000000-0000-4000-8000-000000000101',
  overdue: '00000000-0000-4000-8000-000000000102',
  today: '00000000-0000-4000-8000-000000000103',
  plaintext: '00000000-0000-4000-8000-000000000104',
} as const;

function berlinIsoDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value['year']}-${value['month']}-${value['day']}`;
}

function addIsoDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function reviewDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

function snapshotEntry(id: keyof typeof snapshotIds, faelligAm: string) {
  return {
    quelle: 'EINSPRUCHSFRIST',
    kontrollart: 'CALCULATED_CONTROL_PROPOSAL',
    id: snapshotIds[id],
    clientId: '00000000-0000-4000-8000-000000000001',
    faelligAm,
    verantwortlichId: null,
  };
}

beforeAll(async () => {
  const stamp = Date.now();
  const tenant = await owner.tenant.create({
    data: { slug: `deadline-daily-review-${stamp}`, name: 'Tagesabschluss DB-Test' },
  });
  tenantId = tenant.id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `deadline-daily-review-${stamp}@test.local`,
        fullName: 'Tagesabschluss Testpartnerin',
        passwordHash: 'x',
      },
    })
  ).id;
  await owner.staffRole.create({ data: { staffUserId: staffId, role: 'PARTNER' } });
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await owner.$disconnect();
  await appPrisma.$disconnect();
});

describeWithDatabase('DeadlineDailyReview DB-Invarianten', () => {
  it('erzwingt den aktuellen Berliner Kontrolltag', async () => {
    const today = berlinIsoDate();
    const tomorrow = addIsoDays(today, 1);

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: reviewDate(tomorrow),
          reviewedBy: staffId,
          openCount: 0,
          overdueCount: 0,
          dueTodayCount: 0,
          entriesSnapshot: { version: 1, reviewDate: tomorrow, entries: [] },
        },
      }),
    ).rejects.toThrow();
  });

  it('blockiert falsche Snapshot-Version, abweichendes Datum und ungültige Einträge', async () => {
    const today = berlinIsoDate();
    const yesterday = addIsoDays(today, -1);
    const tomorrow = addIsoDays(today, 1);
    const todayDate = reviewDate(today);

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: todayDate,
          reviewedBy: staffId,
          openCount: 0,
          overdueCount: 0,
          dueTodayCount: 0,
          entriesSnapshot: { version: 2, reviewDate: today, entries: [] },
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: todayDate,
          reviewedBy: staffId,
          openCount: 1,
          overdueCount: 0,
          dueTodayCount: 1,
          escalationNote: 'Der unvollständige Eintrag darf nicht gespeichert werden.',
          entriesSnapshot: {
            version: 1,
            reviewDate: today,
            entries: [{ quelle: 'EINSPRUCHSFRIST', id: 'missing-required-fields' }],
          },
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: todayDate,
          reviewedBy: staffId,
          openCount: 0,
          overdueCount: 0,
          dueTodayCount: 0,
          entriesSnapshot: { version: 1, reviewDate: yesterday, entries: [] },
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: todayDate,
          reviewedBy: staffId,
          openCount: 1,
          overdueCount: 0,
          dueTodayCount: 1,
          escalationNote: 'Zukunftseintrag darf nicht im Tagesabschluss stehen.',
          entriesSnapshot: {
            version: 1,
            reviewDate: today,
            entries: [snapshotEntry('future', tomorrow)],
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('leitet alle Zähler exakt aus den Snapshot-Einträgen ab', async () => {
    const today = berlinIsoDate();
    const yesterday = addIsoDays(today, -1);

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: reviewDate(today),
          reviewedBy: staffId,
          openCount: 2,
          overdueCount: 0,
          dueTodayCount: 0,
          escalationNote: 'Beide offenen Fristen sind eskaliert.',
          entriesSnapshot: {
            version: 1,
            reviewDate: today,
            entries: [snapshotEntry('overdue', yesterday), snapshotEntry('today', today)],
          },
        },
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['clientName', { clientName: 'Muster GmbH' }],
    ['titel', { titel: 'ESt-Bescheid 2025' }],
  ])('weist das Klartextfeld %s im append-only Snapshot ab', async (_field, plaintext) => {
    const today = berlinIsoDate();

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: reviewDate(today),
          reviewedBy: staffId,
          openCount: 1,
          overdueCount: 0,
          dueTodayCount: 1,
          escalationNote: 'Der offene Eintrag ist eskaliert.',
          entriesSnapshot: {
            version: 1,
            reviewDate: today,
            entries: [{ ...snapshotEntry('plaintext', today), ...plaintext }],
          },
        },
      }),
    ).rejects.toThrow(/only contain pseudonymous control fields/);
  });

  it.each([
    ['id', { id: 'Einspruch Müller' }],
    ['clientId', { clientId: 'Max Mustermann' }],
    ['verantwortlichId', { verantwortlichId: 'Sachbearbeiterin Erika' }],
  ])('weist Klartext unter dem erlaubten ID-Feld %s ab', async (_field, plaintext) => {
    const today = berlinIsoDate();

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: reviewDate(today),
          reviewedBy: staffId,
          openCount: 1,
          overdueCount: 0,
          dueTodayCount: 1,
          escalationNote: 'Der offene Eintrag ist eskaliert.',
          entriesSnapshot: {
            version: 1,
            reviewDate: today,
            entries: [{ ...snapshotEntry('plaintext', today), ...plaintext }],
          },
        },
      }),
    ).rejects.toThrow(/identifiers must be canonical UUIDs/);
  });

  it.each([
    ['einen unbekannten Wert', { kontrollart: 'RECHTSFRIST' }],
    [
      'eine interne Risikoklassifikation für einen operativen Termin',
      { quelle: 'STEUERTERMIN', kontrollart: 'INTERNAL_RISK' },
    ],
    [
      'eine operative Klassifikation für einen Kontrollvorschlag',
      { quelle: 'EINSPRUCHSFRIST', kontrollart: 'OPERATIONAL_DUE_DATE' },
    ],
  ])('weist %s im Kontrollsnapshot ab', async (_case, invalidClassification) => {
    const today = berlinIsoDate();

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: reviewDate(today),
          reviewedBy: staffId,
          openCount: 1,
          overdueCount: 0,
          dueTodayCount: 1,
          escalationNote: 'Der offene Eintrag ist eskaliert.',
          entriesSnapshot: {
            version: 1,
            reviewDate: today,
            entries: [{ ...snapshotEntry('plaintext', today), ...invalidClassification }],
          },
        },
      }),
    ).rejects.toThrow(/invalid entry/);
  });

  it('weist Klartext auch außerhalb der Eintragsliste ab', async () => {
    const today = berlinIsoDate();

    await expect(
      owner.deadlineDailyReview.create({
        data: {
          tenantId,
          reviewDate: reviewDate(today),
          reviewedBy: staffId,
          openCount: 0,
          overdueCount: 0,
          dueTodayCount: 0,
          entriesSnapshot: {
            version: 1,
            reviewDate: today,
            entries: [],
            clientName: 'Muster GmbH',
          },
        },
      }),
    ).rejects.toThrow(/only contain version, reviewDate and entries/);
  });

  it('bindet snapshot_at an die Transaktion und reviewed_at an den DB-Abschluss', async () => {
    const today = berlinIsoDate();
    const yesterday = addIsoDays(today, -1);
    const clientSuppliedTimestamp = new Date('2000-01-01T00:00:00.000Z');

    const { created, transactionStartedAt } = await owner.$transaction(
      async (tx) => {
        const [clock] = await tx.$queryRaw<Array<{ snapshotAt: Date }>>`
          SELECT transaction_timestamp() AS "snapshotAt"
        `;
        if (!clock) throw new Error('Transaktionszeitpunkt fehlt.');

        const row = await tx.deadlineDailyReview.create({
          data: {
            tenantId,
            reviewDate: reviewDate(today),
            snapshotAt: clientSuppliedTimestamp,
            reviewedAt: clientSuppliedTimestamp,
            reviewedBy: staffId,
            openCount: 2,
            overdueCount: 1,
            dueTodayCount: 1,
            escalationNote: 'Partnerin übernimmt die offenen Fristen.',
            entriesSnapshot: {
              version: 1,
              reviewDate: today,
              entries: [
                snapshotEntry('overdue', yesterday),
                { ...snapshotEntry('today', today), verantwortlichId: staffId },
              ],
            },
          },
        });

        return { created: row, transactionStartedAt: clock.snapshotAt };
      },
      { isolationLevel: 'RepeatableRead' },
    );

    expect(created.reviewDate.toISOString().slice(0, 10)).toBe(today);
    expect(created.snapshotAt).not.toEqual(clientSuppliedTimestamp);
    expect(created.snapshotAt).toEqual(transactionStartedAt);
    expect(created.reviewedAt).not.toEqual(clientSuppliedTimestamp);
    expect(created.reviewedAt.getTime()).toBeGreaterThanOrEqual(created.snapshotAt.getTime());
    expect(created).toMatchObject({ openCount: 2, overdueCount: 1, dueTodayCount: 1 });
  });

  it('verwirft tenantfremde Actor-GUCs bei INSERT und SELECT', async () => {
    const stamp = Date.now();
    const foreignTenant = await owner.tenant.create({
      data: { slug: `daily-review-cross-tenant-${stamp}`, name: 'Fremdtenant Tagesabschluss' },
    });
    const foreignStaff = await owner.staffUser.create({
      data: {
        tenantId: foreignTenant.id,
        email: `daily-review-cross-${stamp}@test.local`,
        fullName: 'Fremdtenant Partner',
        passwordHash: 'x',
      },
    });
    const today = berlinIsoDate();
    const emptyReview = {
      tenantId: foreignTenant.id,
      reviewDate: reviewDate(today),
      reviewedBy: staffId,
      openCount: 0,
      overdueCount: 0,
      dueTodayCount: 0,
      entriesSnapshot: { version: 1, reviewDate: today, entries: [] },
    };

    await expect(
      withTenantContext(
        { tenantId: foreignTenant.id, actorId: staffId, actorType: 'STAFF' },
        (tx) => tx.deadlineDailyReview.create({ data: emptyReview }),
      ),
    ).rejects.toThrow(/row-level security/i);

    await owner.deadlineDailyReview.create({
      data: { ...emptyReview, reviewedBy: foreignStaff.id },
    });
    await expect(
      withTenantContext(
        { tenantId: foreignTenant.id, actorId: staffId, actorType: 'STAFF' },
        (tx) => tx.deadlineDailyReview.findMany(),
      ),
    ).resolves.toEqual([]);

    await owner.tenant.delete({ where: { id: foreignTenant.id } });
  });

  it('verweigert einem deaktivierten Partner INSERT und SELECT', async () => {
    const stamp = Date.now();
    const inactiveTenant = await owner.tenant.create({
      data: { slug: `daily-review-inactive-${stamp}`, name: 'Inaktiver Tagesabschluss' },
    });
    const inactiveStaff = await owner.staffUser.create({
      data: {
        tenantId: inactiveTenant.id,
        email: `daily-review-inactive-${stamp}@test.local`,
        fullName: 'Inaktiver Partner',
        passwordHash: 'x',
        active: false,
        roles: { create: { role: 'PARTNER' } },
      },
    });
    const today = berlinIsoDate();
    const emptyReview = {
      tenantId: inactiveTenant.id,
      reviewDate: reviewDate(today),
      reviewedBy: inactiveStaff.id,
      openCount: 0,
      overdueCount: 0,
      dueTodayCount: 0,
      entriesSnapshot: { version: 1, reviewDate: today, entries: [] },
    };

    await expect(
      withTenantContext(
        { tenantId: inactiveTenant.id, actorId: inactiveStaff.id, actorType: 'STAFF' },
        (tx) => tx.deadlineDailyReview.create({ data: emptyReview }),
      ),
    ).rejects.toThrow(/row-level security/i);

    await owner.deadlineDailyReview.create({ data: emptyReview });
    await expect(
      withTenantContext(
        { tenantId: inactiveTenant.id, actorId: inactiveStaff.id, actorType: 'STAFF' },
        (tx) => tx.deadlineDailyReview.findMany(),
      ),
    ).resolves.toEqual([]);

    await owner.tenant.delete({ where: { id: inactiveTenant.id } });
  });
});
