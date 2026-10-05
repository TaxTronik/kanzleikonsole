// Fachkatalog: ACCESS-CLIENT-MODE-001
// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
//
// P-15: filterStaffAccessClientsTx liest Policy, Rollen, Vertraulichkeit und
// Zuständigkeiten einmal je Aufruf. Für jedes Mitarbeiter/Mandanten-Paar muss
// sie dieselbe Entscheidung liefern wie filterStaffAccessClientTx je Mandant:
// geprüft über OPEN und RESTRICTED, vertrauliche Mandanten, ADMIN/PARTNER,
// Hauptbearbeiter/Berufsträger, andere Zuständigkeitsrollen, inaktive und
// tenantfremde Mitarbeiter sowie unbekannte Mandanten.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { filterStaffAccessClientTx, filterStaffAccessClientsTx } from '../staff-client-access';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Zugriffsfilter-Batchtest braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId = '';
let foreignTenantId = '';
const staff: Record<string, string> = {};
const clients: Record<string, string> = {};

async function createStaff(
  key: string,
  tenant: string,
  roles: Array<'ADMIN' | 'PARTNER' | 'EMPLOYEE'>,
  active = true,
): Promise<void> {
  staff[key] = (
    await owner.staffUser.create({
      data: {
        tenantId: tenant,
        email: `${key}-${randomUUID()}@example.test`,
        fullName: `Synthetic ${key}`,
        passwordHash: 'x',
        active,
        roles: { create: roles.map((role) => ({ role })) },
      },
    })
  ).id;
}

describeWithDatabase('filterStaffAccessClientsTx entspricht der Einzelprüfung', () => {
  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `access-batch-${suffix}`, name: 'Access batch' } })
    ).id;
    foreignTenantId = (
      await owner.tenant.create({ data: { slug: `access-foreign-${suffix}`, name: 'Foreign' } })
    ).id;
    await createStaff('admin', tenantId, ['ADMIN']);
    await createStaff('partner', tenantId, ['EMPLOYEE', 'PARTNER']);
    await createStaff('hb', tenantId, ['EMPLOYEE']);
    await createStaff('bt', tenantId, []);
    await createStaff('vertreter', tenantId, ['EMPLOYEE']);
    await createStaff('plain', tenantId, ['EMPLOYEE']);
    await createStaff('inactiveAdmin', tenantId, ['ADMIN'], false);
    await createStaff('inactiveHb', tenantId, ['EMPLOYEE'], false);
    await createStaff('foreignAdmin', foreignTenantId, ['ADMIN']);
    for (const [key, vertraulich] of [
      ['open', false],
      ['secret', true],
      ['assigned', false],
      ['assignedSecret', true],
    ] as const) {
      clients[key] = (
        await owner.client.create({
          data: { tenantId, name: `Synthetic ${key}`, kind: 'JURPERS', vertraulich },
        })
      ).id;
    }
    await owner.clientResponsibility.createMany({
      data: [
        {
          tenantId,
          clientId: clients['assigned']!,
          staffId: staff['hb']!,
          role: 'HAUPTBEARBEITER',
        },
        {
          tenantId,
          clientId: clients['assignedSecret']!,
          staffId: staff['hb']!,
          role: 'HAUPTBEARBEITER',
        },
        {
          tenantId,
          clientId: clients['assignedSecret']!,
          staffId: staff['bt']!,
          role: 'BERUFSTRAEGER',
        },
        { tenantId, clientId: clients['secret']!, staffId: staff['vertreter']!, role: 'VERTRETER' },
        {
          tenantId,
          clientId: clients['secret']!,
          staffId: staff['inactiveHb']!,
          role: 'HAUPTBEARBEITER',
        },
      ],
    });
  });

  afterAll(async () => {
    for (const id of [tenantId, foreignTenantId]) {
      if (id) await owner.tenant.delete({ where: { id } });
    }
    await owner.$disconnect();
  });

  async function compare(mode: 'OPEN' | 'RESTRICTED') {
    await owner.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'access' } },
      create: { tenantId, key: 'access', value: { clientAccessMode: mode } },
      update: { value: { clientAccessMode: mode } },
    });
    const staffIds = [...Object.values(staff), randomUUID(), ''];
    const clientIds = [...Object.values(clients), randomUUID()];
    return owner.$transaction(async (tx) => {
      const batch = await filterStaffAccessClientsTx(
        tx,
        tenantId,
        new Map(clientIds.map((clientId) => [clientId, staffIds])),
      );
      const single = new Map<string, Set<string>>();
      for (const clientId of clientIds) {
        single.set(clientId, await filterStaffAccessClientTx(tx, tenantId, staffIds, clientId));
      }
      return { batch, single };
    });
  }

  function names(ids: Set<string> | undefined): string[] {
    const byId = new Map(Object.entries(staff).map(([key, id]) => [id, key]));
    return [...(ids ?? [])].map((id) => byId.get(id) ?? id).sort();
  }

  it.each(['OPEN', 'RESTRICTED'] as const)('liefert im Modus %s dieselben Paare', async (mode) => {
    const { batch, single } = await compare(mode);

    expect(batch.size).toBe(single.size);
    for (const [clientId, allowed] of single) {
      expect(names(batch.get(clientId))).toEqual(names(allowed));
    }
    // Stichprobe der Entscheidungstabelle, unabhängig von der Implementierung.
    const open = mode === 'OPEN';
    expect(names(batch.get(clients['open']!))).toEqual(
      open ? ['admin', 'bt', 'hb', 'partner', 'plain', 'vertreter'] : ['admin', 'partner'],
    );
    expect(names(batch.get(clients['secret']!))).toEqual(['admin', 'partner']);
    expect(names(batch.get(clients['assignedSecret']!))).toEqual(['admin', 'bt', 'hb', 'partner']);
    expect(names(batch.get(clients['assigned']!))).toEqual(
      open ? ['admin', 'bt', 'hb', 'partner', 'plain', 'vertreter'] : ['admin', 'hb', 'partner'],
    );
  });

  it('liest Policy, Mitarbeiter, Mandanten und Zuständigkeiten je Aufruf nur einmal', async () => {
    const queries: string[] = [];
    await owner.$transaction(async (tx) => {
      const counting = new Proxy(tx, {
        get(target, model: string) {
          const delegate = (target as unknown as Record<string, unknown>)[model];
          if (!delegate || typeof delegate !== 'object') return delegate;
          return new Proxy(delegate as object, {
            get(inner, method: string) {
              const fn = (inner as Record<string, unknown>)[method];
              if (typeof fn !== 'function') return fn;
              return (...args: unknown[]) => {
                queries.push(`${model}.${method}`);
                return (fn as (...a: unknown[]) => unknown).apply(inner, args);
              };
            },
          });
        },
      });
      await filterStaffAccessClientsTx(
        counting,
        tenantId,
        new Map(Object.values(clients).map((clientId) => [clientId, Object.values(staff)])),
      );
    });
    expect(queries.sort()).toEqual(
      [
        'client.findMany',
        'clientResponsibility.findMany',
        'staffUser.findMany',
        'tenantSetting.findUnique',
      ].sort(),
    );
  });
});
