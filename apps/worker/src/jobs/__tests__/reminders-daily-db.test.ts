// Fachkatalog: TAX-CONTROL-STATUS-001, ACCESS-NOTIFICATION-RECIPIENT-001
// =============================================================================
// P-15: reminders-daily gegen echtes PostgreSQL.
//
// 230 Mandanten (zwei Abschnitte à höchstens 200) mit fälligen Wiedervorlagen,
// überfälligen Pendelordnern und internen Wiedervorlagen. Die erwarteten
// Hinweise folgen unabhängig von der Implementierung aus der Zugriffsregel
// (aktiv, OPEN oder Zuständigkeit bei vertraulichen Mandanten): pro Empfänger
// und Ressource genau ein Hinweis, kein Hinweis an ausgeschiedene oder nicht
// berechtigte Personen, ein zweiter Lauf am selben Tag schreibt nichts.
// Dieselbe Erwartung erfüllte die vorherige Ein-Transaktions-Fassung.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1); eigener Tenant,
// der am Ende samt Kaskade gelöscht wird.
// =============================================================================

import { randomUUID } from 'node:crypto';
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

import { processors } from './mocks/bullmq';
import { prismaOwner } from '../../prisma-owner';
import { berlinTodayUtcMidnight } from '../../date-util';
import '../reminders-daily';

const CLIENTS = 230;
const DAY_MS = 24 * 60 * 60 * 1000;
const describeDb = enabled ? describe : describe.skip;

describeDb('P-15 reminders-daily against PostgreSQL', () => {
  let tenantId = '';
  const staff = { admin: '', plain: '', hb: '', inactive: '' };
  const expected = new Set<string>();

  const key = (staffId: string | null, kind: string, resourceId: string | null) =>
    `${staffId}|${kind}|${resourceId}`;

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await prismaOwner.tenant.create({
        data: { slug: `p15-${suffix}`, name: 'P-15 reminders-daily' },
      })
    ).id;
    for (const [name, active] of [
      ['admin', true],
      ['plain', true],
      ['hb', true],
      ['inactive', false],
    ] as const) {
      staff[name] = (
        await prismaOwner.staffUser.create({
          data: {
            tenantId,
            email: `p15-${name}-${suffix}@example.test`,
            fullName: `Synthetic ${name}`,
            passwordHash: 'x',
            active,
            roles: { create: [{ role: name === 'admin' ? 'ADMIN' : 'EMPLOYEE' }] },
          },
        })
      ).id;
    }

    const clients = await prismaOwner.client.createManyAndReturn({
      data: Array.from({ length: CLIENTS }, (_, index) => ({
        tenantId,
        name: `Synthetic P-15 client ${index}`,
        kind: 'JURPERS' as const,
        vertraulich: index % 10 === 0,
      })),
      select: { id: true, name: true, vertraulich: true },
    });
    clients.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    await prismaOwner.clientResponsibility.createMany({
      data: clients
        .filter((_, index) => index % 20 === 0)
        .map((client) => ({ tenantId, clientId: client.id, staffId: staff.hb })),
    });

    const today = berlinTodayUtcMidnight(new Date());
    const reminders = await prismaOwner.clientReminder.createManyAndReturn({
      data: [
        ...clients.map((client, index) => ({
          tenantId,
          clientId: client.id,
          dueDate: index % 3 === 0 ? new Date(today.getTime() - DAY_MS) : today,
          subject: `Aufgabe ${index}`,
          createdByStaff: staff.admin,
        })),
        {
          tenantId,
          clientId: null,
          dueDate: today,
          subject: 'Intern aktiv',
          createdByStaff: staff.admin,
        },
        {
          tenantId,
          clientId: null,
          dueDate: today,
          subject: 'Intern ausgeschieden',
          createdByStaff: staff.admin,
        },
      ],
      select: { id: true, clientId: true, subject: true },
    });
    const clientIndex = new Map(clients.map((client, index) => [client.id, index]));
    const assignees: Array<{ reminderId: string; staffId: string }> = [];
    for (const reminder of reminders) {
      if (reminder.clientId === null) {
        const staffId = reminder.subject === 'Intern aktiv' ? staff.plain : staff.inactive;
        assignees.push({ reminderId: reminder.id, staffId });
        if (staffId === staff.plain) expected.add(key(staffId, 'CLIENT_REMINDER_DUE', reminder.id));
        continue;
      }
      const index = clientIndex.get(reminder.clientId)!;
      const confidential = index % 10 === 0;
      const staffId =
        index % 7 === 0
          ? staff.inactive
          : confidential && index % 20 === 0
            ? staff.hb
            : staff.plain;
      assignees.push({ reminderId: reminder.id, staffId });
      // OPEN: aktive Mitarbeiter sehen nicht vertrauliche Mandanten; vertrauliche
      // nur mit Hauptbearbeiter-/Berufsträger-Zuständigkeit.
      const allowed =
        staffId !== staff.inactive && (!confidential || (staffId === staff.hb && index % 20 === 0));
      if (allowed) expected.add(key(staffId, 'CLIENT_REMINDER_DUE', reminder.id));
    }
    await prismaOwner.clientReminderAssignee.createMany({ data: assignees });

    const binders = await prismaOwner.pendingBinder.createManyAndReturn({
      data: [3, 150, 211, 20].map((index) => ({
        tenantId,
        clientId: clients[index]!.id,
        label: `Ordner ${index}`,
        status: 'WITH_CLIENT' as const,
        expectedReturnAt: new Date(today.getTime() - 2 * DAY_MS),
        createdByStaff: staff.plain,
      })),
      select: { id: true, clientId: true },
    });
    for (const binder of binders) {
      const index = clientIndex.get(binder.clientId)!;
      // Mandant 20 ist vertraulich, der Ersteller ohne Zuständigkeit.
      if (index % 10 !== 0) expected.add(key(staff.plain, 'PENDING_BINDER_OVERDUE', binder.id));
    }
  });

  afterAll(async () => {
    if (tenantId) await prismaOwner.tenant.delete({ where: { id: tenantId } });
    await prismaOwner.$disconnect();
  });

  async function storedKeys(): Promise<string[]> {
    const rows = await prismaOwner.notification.findMany({
      where: { tenantId, kind: { in: ['CLIENT_REMINDER_DUE', 'PENDING_BINDER_OVERDUE'] } },
      select: { staffId: true, kind: true, resourceId: true },
    });
    return rows.map((row) => key(row.staffId, row.kind, row.resourceId)).sort();
  }

  it('schreibt über mehrere Abschnitte genau die berechtigten Hinweise, einmal je Tag', async () => {
    const run = () => processors.get('reminders-daily')!({ data: { tenantId } });

    const first = await run();
    const reminderCount = [...expected].filter((entry) =>
      entry.includes('|CLIENT_REMINDER_DUE|'),
    ).length;
    expect(first).toEqual({
      appeal: 0,
      reminders: reminderCount,
      binders: expected.size - reminderCount,
    });
    expect(await storedKeys()).toEqual([...expected].sort());
    expect(reminderCount).toBeGreaterThan(150);

    expect(await run()).toEqual({ appeal: 0, reminders: 0, binders: 0 });
    expect(await storedKeys()).toEqual([...expected].sort());
  });
});
