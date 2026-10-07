// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001, WORKFLOW-DEPENDENCY-001
// Gleichwertigkeit der Relationsfilter (accessibleClientsWhereFor +
// client-access-filter.ts) mit der früheren NOT-IN-Liste gesperrter Mandanten
// (inaccessibleClientIdsFor, entfernt mit Review-Finding P-09): dieselben
// Zeilen bleiben sichtbar, für OPEN und RESTRICTED, vertrauliche und
// zugeordnete Mandanten, Pflicht- und nullable Mandantenbezug. Echtes
// PostgreSQL über die App-Rolle (RLS); nur die Request-Authentisierung fehlt.
// P-02: die Abhängigkeitsübersicht der Mandatsorganisation filtert sichtbare
// Mandanten ebenso als Relationsfilter statt über die ersten 1.000 IDs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
// Die Abhängigkeitsübersicht liest nur; die Audit-Kette ist nicht Gegenstand.
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));

import { accessibleClientsWhereFor, isStaffAdmin } from '@/server/auth/rbac';
import { clientAccessFilter, optionalClientAccessFilter } from '@/server/auth/client-access-filter';
import { decideClientAccess, readAccessPolicyTx } from '@/server/settings/access-policy';
import { loadDependenciesTx } from '@/server/mandate-expansion/service';

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

// Frühere Obergrenze von `visibleMandatesTx` (erste 1.000 Mandanten nach Namen).
const LEGACY_MANDATE_CAP = 1000;
// Öffentliche Mandanten m-0001 … m-1003: mehr als der frühere Deckel.
const PUBLIC_MANDATES = LEGACY_MANDATE_CAP + 3;
const mandateName = (n: number) => `m-${String(n).padStart(4, '0')}`;

(enabled ? describe : describe.skip)('P-02 Mandats-Abhängigkeiten ohne 1.000er-Deckel', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId = '';
  let employeeId = '';
  let adminId = '';
  // Mandantenname → ID des einzigen Workflow-Schritts dieses Mandanten.
  const stepOf = new Map<string, string>();

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `p02-${suffix}`, name: 'P-02 Abhängigkeiten' } })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId, key: 'access', value: { clientAccessMode: 'OPEN' } },
    });
    const staff = async (role: 'EMPLOYEE' | 'ADMIN') =>
      (
        await owner.staffUser.create({
          data: {
            tenantId,
            email: `p02-${role.toLowerCase()}-${randomUUID()}@example.test`,
            fullName: role,
            passwordHash: 'x',
            roles: { create: { role } },
          },
        })
      ).id;
    employeeId = await staff('EMPLOYEE');
    adminId = await staff('ADMIN');
    await owner.client.createMany({
      data: Array.from({ length: PUBLIC_MANDATES }, (_, i) => ({
        tenantId,
        kind: 'NATPERS' as const,
        name: mandateName(i + 1),
      })),
    });
    // Nach allen m-… sortiert: zugeordnet-vertraulich (sichtbar), vertraulich
    // ohne Zuordnung (nur Admin) und anonymisiert (für niemanden).
    await owner.client.createMany({
      data: ['z-vertraulich-zugeordnet', 'z-vertraulich', 'z-anonymisiert'].map((name) => ({
        tenantId,
        kind: 'NATPERS' as const,
        name,
        vertraulich: name.startsWith('z-vertraulich'),
      })),
    });
    const ids = new Map(
      (await owner.client.findMany({ where: { tenantId }, select: { id: true, name: true } })).map(
        (row) => [row.name, row.id],
      ),
    );
    await owner.clientResponsibility.create({
      data: {
        tenantId,
        clientId: ids.get('z-vertraulich-zugeordnet')!,
        staffId: employeeId,
        role: 'HAUPTBEARBEITER',
      },
    });
    const withSteps = [
      mandateName(1),
      mandateName(LEGACY_MANDATE_CAP),
      mandateName(LEGACY_MANDATE_CAP + 1),
      mandateName(PUBLIC_MANDATES),
      'z-vertraulich-zugeordnet',
      'z-vertraulich',
      'z-anonymisiert',
    ];
    for (const [index, name] of withSteps.entries()) {
      const instance = await owner.workflowInstance.create({
        data: {
          tenantId,
          clientId: ids.get(name)!,
          name: `Jahresabschluss ${name}`,
          assessmentYear: 2026,
          startedByStaff: adminId,
        },
      });
      const step = await owner.workflowItem.create({
        data: {
          instanceId: instance.id,
          position: 0,
          title: `Schritt ${name}`,
          // Eindeutige Reihenfolge der Übersicht (neueste zuerst).
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        },
      });
      stepOf.set(name, step.id);
    }
    await owner.client.update({
      where: { id: ids.get('z-anonymisiert')! },
      data: { anonymizedAt: new Date() },
    });
    // Vorgänger jenseits des früheren Deckels → Nachfolger m-0001; ein für den
    // Mitarbeiter verborgener Vorgänger → Nachfolger m-1001.
    for (const [from, to] of [
      [mandateName(PUBLIC_MANDATES), mandateName(1)],
      ['z-vertraulich', mandateName(LEGACY_MANDATE_CAP + 1)],
    ] as const) {
      await owner.workflowDependency.create({
        data: {
          tenantId,
          predecessorItemId: stepOf.get(from)!,
          successorItemId: stepOf.get(to)!,
          createdBy: adminId,
        },
      });
    }
  });

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
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

  const nameOfStep = (id: string) => [...stepOf].find(([, step]) => step === id)?.[0];

  // Wortgleiche Mandantenabfrage des entfernten `visibleMandatesTx` mit Deckel
  // (`take`) bzw. ohne Deckel als Referenz derselben Sichtbarkeitsregel.
  async function legacyVisibleIds(tx: TxClient, s: StaffSession, take?: number) {
    const rows = await tx.client.findMany({
      where: { AND: [await accessibleClientsWhereFor(tx, s), { anonymizedAt: null }] },
      select: { id: true },
      orderBy: { name: 'asc' },
      ...(take === undefined ? {} : { take }),
    });
    return rows.map((row) => row.id);
  }

  async function legacyStepNames(tx: TxClient, ids: string[]) {
    const rows = await tx.workflowItem.findMany({
      where: { instance: { tenantId, clientId: { in: ids } } },
      select: { id: true },
    });
    return rows.map((row) => nameOfStep(row.id)).sort();
  }

  it.each([
    [
      'EMPLOYEE',
      [
        mandateName(1),
        mandateName(LEGACY_MANDATE_CAP),
        mandateName(LEGACY_MANDATE_CAP + 1),
        mandateName(PUBLIC_MANDATES),
        'z-vertraulich-zugeordnet',
      ],
    ],
    [
      'ADMIN',
      [
        mandateName(1),
        mandateName(LEGACY_MANDATE_CAP),
        mandateName(LEGACY_MANDATE_CAP + 1),
        mandateName(PUBLIC_MANDATES),
        'z-vertraulich-zugeordnet',
        'z-vertraulich',
      ],
    ],
  ] as const)(
    '%s: Schritte aller sichtbaren Mandanten, auch jenseits von 1.000',
    async (role, expected) => {
      const staffId = role === 'ADMIN' ? adminId : employeeId;
      const s = session(staffId, role);
      const result = await asStaff(staffId, async (tx) => {
        const all = await legacyVisibleIds(tx, s);
        const capped = await legacyVisibleIds(tx, s, LEGACY_MANDATE_CAP);
        return {
          visibleCount: all.length,
          reference: await legacyStepNames(tx, all),
          legacy: await legacyStepNames(tx, capped),
          data: await loadDependenciesTx(tx, s),
        };
      });

      // Mehr sichtbare Mandanten als der frühere Deckel.
      expect(result.visibleCount).toBeGreaterThan(LEGACY_MANDATE_CAP);
      const names = result.data.items.map((item) => nameOfStep(item.id)).sort();
      expect(names).toEqual([...expected].sort());
      // Dieselbe Sichtbarkeitsregel wie die ungekappte Mandantenabfrage.
      expect(names).toEqual(result.reference);
      // Grenze des alten Deckels: Mandant 1.000 war noch enthalten, 1.001 nicht mehr.
      expect(result.legacy).toEqual([mandateName(1), mandateName(LEGACY_MANDATE_CAP)]);
      // Neueste zuerst, Namen nur für die Mandanten der geladenen Schritte.
      expect(result.data.items.map((item) => item.createdAt.getTime())).toEqual(
        [...result.data.items.map((item) => item.createdAt.getTime())].sort((a, b) => b - a),
      );
      expect(result.data.clients.map((client) => client.name).sort()).toEqual([...expected].sort());
      expect(result.data.items.every((item) => !('client' in item.instance))).toBe(true);
    },
  );

  it('bewertet Vorgänger jenseits des früheren Deckels und hält verborgene zurück', async () => {
    const first = stepOf.get(mandateName(1))!;
    const beyond = stepOf.get(mandateName(LEGACY_MANDATE_CAP + 1))!;
    const employee = await asStaff(employeeId, (tx) =>
      loadDependenciesTx(tx, session(employeeId, 'EMPLOYEE')),
    );
    // m-1003 → m-0001: früher fehlte der Vorgänger (Mandant 1.003) und der
    // Nachfolger galt als „nicht feststellbar“; jetzt zählt der echte Stand.
    expect(employee.dependencies.map((d) => [d.predecessorItemId, d.successorItemId])).toEqual([
      [stepOf.get(mandateName(PUBLIC_MANDATES)), first],
    ]);
    expect(employee.blockedTargets.has(first)).toBe(false);
    // Vertraulicher Vorgänger ohne Zuordnung: keine positive Bereitschaft.
    expect([...employee.blockedTargets]).toEqual([beyond]);

    const admin = await asStaff(adminId, (tx) => loadDependenciesTx(tx, session(adminId, 'ADMIN')));
    expect(admin.dependencies).toHaveLength(2);
    expect(admin.blockedTargets.size).toBe(0);
  });
});
