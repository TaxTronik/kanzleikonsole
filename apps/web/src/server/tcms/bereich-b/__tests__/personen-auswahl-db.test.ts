// Fachkatalog: TCMS-AKTEUR-001, ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001
// TCMS Stufe 3, Bereich B: Auswahllisten der Zuständigkeiten gegen echtes
// PostgreSQL über die App-Rolle (RLS). Kanzlei: nur aktive Mitarbeitende des
// Tenants mit Zugriff auf den Mandanten (vertraulich: nur Zugeordnete);
// Mandantenseite: nur aktive Kontakte genau dieses Mandanten mit Rolle laut
// Dienst. Die Liste ist ein Angebot; die Aktion prüft jede ID erneut.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TxClient } from '@taxtronik/db';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { kanzleiPersonenAuswahlTx, mandantPersonenAuswahlTx } from '../personen-auswahl';

const enabled = process.env.TCMS_SEITE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_SEITE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

(enabled ? describe : describe.skip)('Auswahllisten der Zuständigkeiten (TCMS Bereich B)', () => {
  // Freigegebene Clients aus @taxtronik/db (prisma-client-guard): Owner nur für
  // Fixtures, die App-Rolle (DATABASE_APP_URL, RLS) für alle Prüfungen. Erst im
  // beforeAll geladen, damit eine übersprungene Suite keine Verbindung braucht.
  let owner!: PrismaClient;
  let app!: PrismaClient;
  const tenants: string[] = [];
  let tenantId = '';
  let fremderTenant = '';
  const staff: Record<string, string> = {};
  const mandant: Record<string, string> = {};
  const kontakt: Record<string, string> = {};

  async function neuerTenant(name: string): Promise<string> {
    const id = (await owner.tenant.create({ data: { slug: `tcms-s3b-${randomUUID()}`, name } })).id;
    tenants.push(id);
    return id;
  }

  async function person(key: string, tenant: string, name: string, active = true) {
    staff[key] = (
      await owner.staffUser.create({
        data: {
          tenantId: tenant,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: name,
          passwordHash: 'synthetic',
          active,
          roles: { create: [{ role: 'EMPLOYEE' }] },
        },
      })
    ).id;
  }

  async function neuerKontakt(key: string, tenant: string, clientKey: string, active = true) {
    kontakt[key] = (
      await owner.clientContact.create({
        data: {
          tenantId: tenant,
          clientId: mandant[clientKey]!,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: `Kontakt ${key}`,
          active,
        },
      })
    ).id;
  }

  beforeAll(async () => {
    ({ prismaOwner: owner, prisma: app } = await import('@taxtronik/db'));
    tenantId = await neuerTenant('TCMS S3b');
    fremderTenant = await neuerTenant('TCMS S3b fremd');
    await person('berta', tenantId, '  Berta Brandt  ');
    await person('anton', tenantId, 'Anton Adler');
    await person('inaktiv', tenantId, 'Ina Inaktiv', false);
    await person('leer', tenantId, '   ');
    await person('fremd', fremderTenant, 'Fritz Fremd');
    const neu = async (key: string, tenant: string, daten: Record<string, unknown> = {}) => {
      mandant[key] = (
        await owner.client.create({
          data: { tenantId: tenant, kind: 'JURPERS', name: `Mandant ${key}`, ...daten },
        })
      ).id;
    };
    await neu('offen', tenantId);
    await neu('vertraulich', tenantId, { vertraulich: true });
    await neu('fremd', fremderTenant);
    await owner.clientResponsibility.create({
      data: {
        tenantId,
        clientId: mandant.vertraulich!,
        staffId: staff.berta!,
        role: 'HAUPTBEARBEITER',
      },
    });
    await neuerKontakt('rolle', tenantId, 'offen');
    await neuerKontakt('ohneRolle', tenantId, 'offen');
    await neuerKontakt('inaktiv', tenantId, 'offen', false);
    await neuerKontakt('andererMandant', tenantId, 'vertraulich');
    await neuerKontakt('fremd', fremderTenant, 'fremd');
  });

  afterAll(async () => {
    try {
      for (const id of tenants) await owner.tenant.delete({ where: { id } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  }, 60_000);

  function imTenant<T>(tenant: string, run: (tx: TxClient) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true),
        set_config('app.current_actor_id', ${staff.anton!}, true),
        set_config('app.current_actor_type', 'STAFF', true)`;
      return run(tx as TxClient);
    });
  }

  it('Kanzlei: aktive Mitarbeitende des Tenants mit Zugriff, nach Name, ohne leere Namen', async () => {
    const liste = await imTenant(tenantId, (tx) =>
      kanzleiPersonenAuswahlTx(tx, { tenantId, mandantId: mandant.offen! }),
    );
    expect(liste).toEqual([
      { id: staff.anton, name: 'Anton Adler', funktion: null },
      { id: staff.berta, name: 'Berta Brandt', funktion: null },
    ]);
  });

  it('Kanzlei, vertraulicher Mandant: nur zugeordnete Mitarbeitende', async () => {
    const liste = await imTenant(tenantId, (tx) =>
      kanzleiPersonenAuswahlTx(tx, { tenantId, mandantId: mandant.vertraulich! }),
    );
    expect(liste.map((p) => p.id)).toEqual([staff.berta]);
  });

  it('Kanzlei: Tenant-Filter zusätzlich zu RLS (fremder Tenant im Bezug → leer)', async () => {
    const liste = await imTenant(tenantId, (tx) =>
      kanzleiPersonenAuswahlTx(tx, { tenantId: fremderTenant, mandantId: mandant.fremd! }),
    );
    expect(liste).toEqual([]);
  });

  it('Mandant: nur aktive Kontakte genau dieses Mandanten mit Rolle laut Dienst', async () => {
    const rollen = new Map<string, string | null>(
      [kontakt.rolle!, kontakt.inaktiv!, kontakt.andererMandant!, kontakt.fremd!].map((id) => [
        id.toLowerCase(),
        'Geschäftsführung',
      ]),
    );
    const liste = await imTenant(tenantId, (tx) =>
      mandantPersonenAuswahlTx(tx, { tenantId, mandantId: mandant.offen! }, rollen),
    );
    expect(liste).toEqual([
      { id: kontakt.rolle, name: 'Kontakt rolle', funktion: 'Geschäftsführung' },
    ]);
  });
});
