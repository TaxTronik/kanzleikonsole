// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001
// Gleichwertigkeit der Relationsfilter (accessibleClientsWhereFor +
// client-access-filter.ts) mit der früheren NOT-IN-Liste gesperrter Mandanten
// (inaccessibleClientIdsFor, entfernt mit Review-Finding P-09): dieselben
// Zeilen bleiben sichtbar, für OPEN und RESTRICTED, vertrauliche und
// zugeordnete Mandanten, Pflicht- und nullable Mandantenbezug. Echtes
// PostgreSQL über die App-Rolle (RLS); nur die Request-Authentisierung fehlt.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));

import { accessibleClientsWhereFor, isStaffAdmin } from '@/server/auth/rbac';
import { clientAccessFilter, optionalClientAccessFilter } from '@/server/auth/client-access-filter';
import { decideClientAccess, readAccessPolicyTx } from '@/server/settings/access-policy';

// Quality hat Platzhalter-URLs, aber keine Datenbank. Der db-Job schaltet den
// Test ausdrücklich ein; fehlende/ungültige URLs müssen dann scheitern.
const enabled = process.env.CLIENT_ACCESS_FILTER_DB_TEST === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`CLIENT_ACCESS_FILTER_DB_TEST requires a valid ${name}.`);
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) {
      throw new Error(`CLIENT_ACCESS_FILTER_DB_TEST requires a PostgreSQL ${name}.`);
    }
  }
}

const QUALIFYING = ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] as const;
type Role = 'BERUFSTRAEGER' | 'HAUPTBEARBEITER' | 'VERTRETER' | 'FACHLICH';

// Mandant → (vertraulich, Zuordnung des geprüften Mitarbeiters bzw. eines Kollegen)
const CLIENTS: ReadonlyArray<{
  name: string;
  vertraulich: boolean;
  own?: Role;
  colleague?: Role;
}> = [
  { name: 'public', vertraulich: false },
  { name: 'public-berufstraeger', vertraulich: false, own: 'BERUFSTRAEGER' },
  { name: 'public-fachlich', vertraulich: false, own: 'FACHLICH' },
  { name: 'confidential', vertraulich: true },
  { name: 'confidential-hauptbearbeiter', vertraulich: true, own: 'HAUPTBEARBEITER' },
  { name: 'confidential-vertreter', vertraulich: true, own: 'VERTRETER' },
  { name: 'confidential-colleague', vertraulich: true, colleague: 'HAUPTBEARBEITER' },
];
const INTERNAL_NOTE = 'note:internal';

(enabled ? describe : describe.skip)('P-09 Relationsfilter = frühere NOT-IN-Liste', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId: string, foreignTenantId: string, employeeId: string, adminId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `p09-${suffix}`, name: 'P-09 Zugriff' } })
    ).id;
    foreignTenantId = (
      await owner.tenant.create({ data: { slug: `p09-foreign-${suffix}`, name: 'P-09 fremd' } })
    ).id;
    const staff = async (role: 'EMPLOYEE' | 'ADMIN', tenant = tenantId) =>
      (
        await owner.staffUser.create({
          data: {
            tenantId: tenant,
            email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
            fullName: role,
            passwordHash: 'x',
            roles: { create: { role } },
          },
        })
      ).id;
    employeeId = await staff('EMPLOYEE');
    adminId = await staff('ADMIN');
    const colleagueId = await staff('EMPLOYEE');
    for (const spec of CLIENTS) {
      const client = await owner.client.create({
        data: { tenantId, kind: 'NATPERS', name: spec.name, vertraulich: spec.vertraulich },
      });
      for (const [staffId, role] of [
        [employeeId, spec.own],
        [colleagueId, spec.colleague],
      ] as const) {
        if (role) {
          await owner.clientResponsibility.create({
            data: { tenantId, clientId: client.id, staffId, role },
          });
        }
      }
      // Pflicht-Mandantenbezug (Kalender) und nullable Bezug (Telefonzettel).
      await owner.appointmentRequest.create({
        data: { tenantId, clientId: client.id, subject: `ar:${spec.name}`, proposedSlots: [] },
      });
      await owner.phoneNote.create({
        data: {
          tenantId,
          clientId: client.id,
          callerName: 'Anrufer',
          subject: `note:${spec.name}`,
          body: '-',
          takenByStaff: employeeId,
        },
      });
    }
    await owner.phoneNote.create({
      data: {
        tenantId,
        callerName: 'Anrufer',
        subject: INTERNAL_NOTE,
        body: '-',
        takenByStaff: employeeId,
      },
    });
    // Fremder Tenant: darf in keinem Modus auftauchen (RLS).
    const foreignStaff = await staff('EMPLOYEE', foreignTenantId);
    const foreignClient = await owner.client.create({
      data: { tenantId: foreignTenantId, kind: 'NATPERS', name: 'foreign', vertraulich: false },
    });
    await owner.phoneNote.create({
      data: {
        tenantId: foreignTenantId,
        clientId: foreignClient.id,
        callerName: 'Anrufer',
        subject: 'note:foreign',
        body: '-',
        takenByStaff: foreignStaff,
      },
    });
  });

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
      if (foreignTenantId) await owner.tenant.delete({ where: { id: foreignTenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  function session(staffId: string, role: 'EMPLOYEE' | 'ADMIN'): StaffSession {
    return { user: { tenantId, staffId, roles: [role], permissions: [] } } as never;
  }

  function asStaff<T>(staffId: string, run: (tx: TxClient) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${staffId}, true),
        set_config('app.current_actor_type', 'STAFF', true)`;
      return run(tx as TxClient);
    });
  }

  // Wortgleiche Abfrage des entfernten `inaccessibleClientIdsFor` als Referenz.
  async function legacyDeniedIds(tx: TxClient, s: StaffSession): Promise<string[]> {
    if (isStaffAdmin(s)) return [];
    const policy = await readAccessPolicyTx(tx, s.user.tenantId);
    const rows = await tx.client.findMany({
      where: {
        ...(policy.clientAccessMode === 'OPEN' ? { vertraulich: true } : {}),
        responsibilities: { none: { staffId: s.user.staffId, role: { in: [...QUALIFYING] } } },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  interface Visible {
    clients: string[];
    appointmentRequests: string[];
    phoneNotes: string[];
  }

  async function visible(
    tx: TxClient,
    clients: Prisma.ClientWhereInput,
    appointmentRequests: Prisma.AppointmentRequestWhereInput,
    phoneNotes: Prisma.PhoneNoteWhereInput,
  ): Promise<Visible> {
    const [c, ar, pn] = await Promise.all([
      tx.client.findMany({ where: clients, select: { name: true } }),
      tx.appointmentRequest.findMany({ where: appointmentRequests, select: { subject: true } }),
      tx.phoneNote.findMany({ where: phoneNotes, select: { subject: true } }),
    ]);
    return {
      clients: c.map((row) => row.name).sort(),
      appointmentRequests: ar.map((row) => row.subject).sort(),
      phoneNotes: pn.map((row) => row.subject).sort(),
    };
  }

  function expectedFor(mode: 'OPEN' | 'RESTRICTED', isAdmin: boolean): Visible {
    const names = CLIENTS.filter((spec) =>
      decideClientAccess({
        isAdmin,
        mode,
        vertraulich: spec.vertraulich,
        isResponsible: spec.own === 'BERUFSTRAEGER' || spec.own === 'HAUPTBEARBEITER',
      }),
    ).map((spec) => spec.name);
    return {
      clients: [...names].sort(),
      appointmentRequests: names.map((name) => `ar:${name}`).sort(),
      phoneNotes: [...names.map((name) => `note:${name}`), INTERNAL_NOTE].sort(),
    };
  }

  it.each([
    ['OPEN', 'EMPLOYEE'],
    ['RESTRICTED', 'EMPLOYEE'],
    ['OPEN', 'ADMIN'],
    ['RESTRICTED', 'ADMIN'],
  ] as const)('%s / %s: dieselben Zeilen wie mit der NOT-IN-Liste', async (mode, role) => {
    await owner.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'access' } },
      create: { tenantId, key: 'access', value: { clientAccessMode: mode } },
      update: { value: { clientAccessMode: mode } },
    });
    const staffId = role === 'ADMIN' ? adminId : employeeId;
    const s = session(staffId, role);

    const { legacy, relation, deniedCount } = await asStaff(staffId, async (tx) => {
      const denied = await legacyDeniedIds(tx, s);
      const legacyResult = await visible(
        tx,
        denied.length ? { id: { notIn: denied } } : {},
        denied.length ? { clientId: { notIn: denied } } : {},
        denied.length ? { OR: [{ clientId: null }, { clientId: { notIn: denied } }] } : {},
      );
      const access = await accessibleClientsWhereFor(tx, s);
      const relationResult = await visible(
        tx,
        access,
        clientAccessFilter(access),
        optionalClientAccessFilter(access),
      );
      return { legacy: legacyResult, relation: relationResult, deniedCount: denied.length };
    });

    expect(relation).toEqual(legacy);
    expect(relation).toEqual(expectedFor(mode, role === 'ADMIN'));
    // Plausibilität der Fixture: RESTRICTED sperrt mehr als OPEN, Admins nichts.
    expect(deniedCount).toBe(
      role === 'ADMIN' ? 0 : CLIENTS.length - expectedFor(mode, false).clients.length,
    );
    expect(relation.phoneNotes).not.toContain('note:foreign');
  });

  it('kombiniert Seitenfilter und Regel im selben client-Schlüssel (kein Überschreiben)', async () => {
    await owner.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'access' } },
      create: { tenantId, key: 'access', value: { clientAccessMode: 'OPEN' } },
      update: { value: { clientAccessMode: 'OPEN' } },
    });
    const s = session(employeeId, 'EMPLOYEE');
    const subjects = await asStaff(employeeId, async (tx) => {
      const access = await accessibleClientsWhereFor(tx, s);
      // „Nur meine Mandanten“ (beliebige Zuordnungsrolle) UND sichtbar.
      const mine = { responsibilities: { some: { staffId: employeeId } } };
      const rows = await tx.appointmentRequest.findMany({
        where: clientAccessFilter(access, mine),
        select: { subject: true },
      });
      return rows.map((row) => row.subject).sort();
    });
    // confidential-vertreter ist zugeordnet, aber als VERTRETER nicht sichtbar.
    expect(subjects).toEqual(
      ['ar:confidential-hauptbearbeiter', 'ar:public-berufstraeger', 'ar:public-fachlich'].sort(),
    );
  });
});
