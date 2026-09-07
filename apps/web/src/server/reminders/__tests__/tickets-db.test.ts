// Fachkatalog: REMINDER-TICKET-001, ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffSession } from '@/server/auth/staff';
import type { TenantContext } from '@taxtronik/db';

// SQL, RLS, policies and production loaders stay real. No Next request is needed.
vi.mock('@/server/auth/staff', () => ({ staffAuth: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));

const enabled = process.env['REMINDER_TICKETS_DB_TEST'] === '1';
(enabled ? describe : describe.skip)('ticket services against PostgreSQL app role', () => {
  let db: typeof import('@taxtronik/db');
  let queries: typeof import('../queries');
  let details: typeof import('../detail');
  let references: typeof import('../references');
  let tenantId: string, foreignTenantId: string, adminId: string, employeeId: string;
  let targetClientId: string,
    sourceId: string,
    targetId: string,
    privateId: string,
    secretId: string;
  let ownId: string, archivedId: string, targetNumber: number;
  let session: StaffSession;
  const createdTenants: string[] = [];
  const ctx = (): TenantContext => ({ tenantId, actorId: employeeId, actorType: 'STAFF' });

  beforeAll(async () => {
    for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
      const url = new URL(process.env[name] ?? '');
      const isolated = url.pathname.startsWith('/reminder_tickets_');
      const ciService = process.env['CI'] === 'true' && url.pathname === '/taxtronik';
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || (!isolated && !ciService)) {
        throw new Error('Explicit isolated local ticket test database required.');
      }
    }
    db = await import('@taxtronik/db');
    queries = await import('../queries');
    details = await import('../detail');
    references = await import('../references');
    for (let n = 0; n < 2; n++) {
      createdTenants.push(
        (
          await db.prismaOwner.tenant.create({
            data: {
              slug: `ticket-service-test-${crypto.randomUUID()}`,
              name: 'Synthetic ticket services',
            },
          })
        ).id,
      );
    }
    [tenantId, foreignTenantId] = createdTenants as [string, string];
    const staff = async (role: 'ADMIN' | 'EMPLOYEE') =>
      (
        await db.prismaOwner.staffUser.create({
          data: {
            tenantId,
            email: `${crypto.randomUUID()}@example.test`,
            fullName: `Synthetic ${role}`,
            passwordHash: 'unused',
            roles: { create: { role } },
          },
        })
      ).id;
    adminId = await staff('ADMIN');
    employeeId = await staff('EMPLOYEE');
    session = {
      expires: '2030-01-01T00:00:00.000Z',
      user: {
        id: employeeId,
        email: 'fixture@example.test',
        name: 'Synthetic EMPLOYEE',
        fullName: 'Synthetic EMPLOYEE',
        tenantId,
        staffId: employeeId,
        roles: ['EMPLOYEE'],
        permissions: [],
      },
    };
    const client = async (vertraulich = false) =>
      (
        await db.prismaOwner.client.create({
          data: {
            tenantId,
            kind: 'JURPERS',
            name: 'Synthetic ticket mandate',
            vertraulich,
          },
        })
      ).id;
    const sourceClientId = await client();
    targetClientId = await client();
    const confidentialClientId = await client(true);
    const ticket = async (subject: string, clientId: string | null, creator = adminId) =>
      db.prismaOwner.clientReminder.create({
        data: {
          tenantId,
          clientId,
          subject,
          createdByStaff: creator,
          dueDate: new Date('2026-09-07'),
          assignees: { create: { staffId: creator } },
        },
      });
    sourceId = (await ticket('Visible source', sourceClientId)).id;
    const target = await ticket('Visible target', targetClientId);
    targetId = target.id;
    targetNumber = target.ticketNumber;
    privateId = (await ticket('Private internal', null)).id;
    secretId = (await ticket('Confidential target', confidentialClientId)).id;
    ownId = (await ticket('Own internal', null, employeeId)).id;
    archivedId = (await ticket('Archived own', null, employeeId)).id;
    await db.prismaOwner.clientReminder.update({
      where: { id: archivedId },
      data: {
        doneAt: new Date(),
        doneByStaff: employeeId,
        archivedAt: new Date(),
        archivedByStaff: employeeId,
      },
    });
    await db.prismaOwner.clientReminder.update({
      where: { id: sourceId },
      data: { predecessorId: privateId },
    });
    await db.prismaOwner.clientReminderReference.create({
      data: {
        tenantId,
        sourceReminderId: privateId,
        targetReminderId: sourceId,
      },
    });
    await db.prismaOwner.clientReminder.create({
      data: {
        tenantId: foreignTenantId,
        subject: 'Foreign #1',
        createdByStaff: crypto.randomUUID(),
        dueDate: new Date('2026-09-07'),
      },
    });
    await db.prismaOwner.clientReminder.createMany({
      data: Array.from({ length: 31 }, (_, i) => ({
        tenantId,
        clientId: sourceClientId,
        subject: `Pagination ticket ${i + 1}`,
        createdByStaff: employeeId,
        dueDate: new Date('2026-09-07'),
      })),
    });
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    for (const id of createdTenants) await db.prismaOwner.tenant.delete({ where: { id } });
    await Promise.all([db.prisma.$disconnect(), db.prismaOwner.$disconnect()]);
  });

  it('resolves UUID and tenant-local number to exactly the same ticket', async () => {
    const numeric = await details.loadReminderDetail(ctx(), session, String(targetNumber));
    const uuid = await details.loadReminderDetail(ctx(), session, targetId);
    expect(numeric?.id).toBe(targetId);
    expect(uuid?.ticketNumber).toBe(targetNumber);
    expect(await details.loadReminderDetail(ctx(), session, 'not-an-id')).toBeNull();
    expect(await details.loadReminderDetail(ctx(), session, '2147483648')).toBeNull();
    expect((await details.loadReminderDetail(ctx(), session, '1'))?.id).toBe(sourceId);
  });

  it('filters inaccessible tickets before counting and paginating all-accessible search', async () => {
    const all = await queries.loadReminderOverview(ctx(), session, {
      scope: 'alle',
      status: 'open',
    });
    expect(all.total).toBe(34);
    expect(all.rows).toHaveLength(25);
    const first = await queries.loadReminderOverview(ctx(), session, {
      scope: 'alle',
      status: 'open',
      q: 'Pagination ticket',
      pageSize: 25,
    });
    const second = await queries.loadReminderOverview(ctx(), session, {
      scope: 'alle',
      status: 'open',
      q: 'Pagination ticket',
      pageSize: 25,
      page: 2,
    });
    expect(first.total).toBe(31);
    expect(second.total).toBe(31);
    expect(first.rows).toHaveLength(25);
    expect(second.rows).toHaveLength(6);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(31);
    expect(all.rows.some((row) => [privateId, secretId, archivedId].includes(row.id))).toBe(false);
  });

  it('separates own assignments, created-by-me and archive', async () => {
    const mine = await queries.loadReminderOverview(ctx(), session, {
      scope: 'mir',
      status: 'open',
    });
    expect(mine.rows.map((row) => row.id)).toEqual([ownId]);
    const created = await queries.loadReminderOverview(ctx(), session, {
      scope: 'vonmir',
      status: 'open',
    });
    expect(created.total).toBe(32);
    const archived = await queries.loadReminderOverview(ctx(), session, {
      scope: 'mir',
      status: 'archived',
    });
    expect(archived.rows.map((row) => row.id)).toEqual([archivedId]);
    const detail = await details.loadReminderDetail(ctx(), session, archivedId);
    expect(detail?.canRestore).toBe(true);
    expect(detail?.canArchive).toBe(false);
  });

  it('persists only readable mentions, deduplicates and omits private backlinks and ancestors', async () => {
    const hidden = await db.prismaOwner.clientReminder.findMany({
      where: { id: { in: [privateId, secretId] } },
    });
    const text = `See #${targetNumber} and #${targetNumber} ${hidden.map((row) => '#' + row.ticketNumber).join(' ')}`;
    await db.withTenantContext(ctx(), (tx) =>
      references.persistReminderReferencesTx(tx, session, sourceId, text),
    );
    await db.withTenantContext(ctx(), (tx) =>
      references.persistReminderReferencesTx(tx, session, sourceId, text),
    );
    const outgoing = await db.prismaOwner.clientReminderReference.findMany({
      where: { sourceReminderId: sourceId },
    });
    expect(outgoing.map((edge) => edge.targetReminderId)).toEqual([targetId]);
    const source = await details.loadReminderDetail(ctx(), session, sourceId);
    expect(source?.vorgaenger).toEqual([]);
    expect(source?.references.map((reference) => reference.id)).toEqual([targetId]);
    const target = await details.loadReminderDetail(ctx(), session, targetId);
    expect(target?.references).toEqual([
      expect.objectContaining({ id: sourceId, direction: 'incoming' }),
    ]);
  });

  it('retains archived target links, but hides them immediately after a mandate access change', async () => {
    await db.prismaOwner.clientReminder.update({
      where: { id: targetId },
      data: {
        doneAt: new Date(),
        doneByStaff: adminId,
        archivedAt: new Date(),
        archivedByStaff: adminId,
      },
    });
    expect(
      (await details.loadReminderDetail(ctx(), session, sourceId))?.references[0]?.archivedAt,
    ).not.toBeNull();
    await db.prismaOwner.client.update({
      where: { id: targetClientId },
      data: { vertraulich: true },
    });
    try {
      expect(await details.loadReminderDetail(ctx(), session, targetId)).toBeNull();
      expect((await details.loadReminderDetail(ctx(), session, sourceId))?.references).toEqual([]);
      const result = await queries.loadReminderOverview(ctx(), session, {
        scope: 'alle',
        status: 'archived',
        q: '#' + targetNumber,
      });
      expect(result.total).toBe(0);
      expect(result.rows).toEqual([]);
      expect(
        await db.prismaOwner.clientReminderReference.count({
          where: { sourceReminderId: sourceId },
        }),
      ).toBe(1);
    } finally {
      await db.prismaOwner.client.update({
        where: { id: targetClientId },
        data: { vertraulich: false },
      });
    }
  });

  it('keeps the newest comment and every older page reachable after archiving', async () => {
    const base = Date.parse('2026-09-01T12:00:00.000Z');
    await db.prismaOwner.clientReminderNote.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        tenantId,
        reminderId: ownId,
        staffId: employeeId,
        body: `History ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    });
    const current = await details.loadReminderDetail(ctx(), session, ownId);
    expect(current?.discussion).toHaveLength(200);
    expect(current?.discussion.at(-1)?.body).toBe('History 200');
    expect(current?.discussion[0]?.body).toBe('History 1');
    await db.prismaOwner.clientReminder.update({
      where: { id: ownId },
      data: {
        doneAt: new Date(),
        doneByStaff: employeeId,
        archivedAt: new Date(),
        archivedByStaff: employeeId,
      },
    });
    const older = await details.loadReminderDetail(ctx(), session, ownId, { commentsPage: 2 });
    expect(older?.discussion.map((note) => note.body)).toEqual(['History 0']);
    expect(older?.archivedAt).not.toBeNull();
  });
});
