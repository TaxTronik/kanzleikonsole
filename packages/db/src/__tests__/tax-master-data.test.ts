// Fachkatalog: TAX-MASTER-DATA-001, ACCESS-TENANT-RLS-001, ACCESS-CLIENT-MODE-001.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
let tenantId: string;
let foreignTenantId: string;
let clientId: string;
let otherClientId: string;
let staffId: string;
let otherStaffId: string;
let contactId: string;
let inactiveContactId: string;
let registrationId: string;
async function asActor<T>(
  actorType: 'STAFF' | 'CLIENT_CONTACT',
  actorId: string,
  work: (tx: TxClient) => Promise<T>,
  tenant = tenantId,
) {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true), set_config('app.current_actor_id', ${actorId}, true), set_config('app.current_actor_type', ${actorType}, true)`;
    return work(tx);
  });
}
beforeAll(async () => {
  const stamp = Date.now();
  tenantId = (
    await owner.tenant.create({ data: { slug: `tax-master-${stamp}`, name: 'Tax master test' } })
  ).id;
  foreignTenantId = (
    await owner.tenant.create({ data: { slug: `tax-master-foreign-${stamp}`, name: 'Foreign' } })
  ).id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Private client', vertraulich: true },
    })
  ).id;
  otherClientId = (
    await owner.client.create({ data: { tenantId, kind: 'NATPERS', name: 'Other client' } })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `tax-staff-${stamp}@example.test`,
        fullName: 'Assigned',
        passwordHash: 'x',
      },
    })
  ).id;
  otherStaffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `tax-other-${stamp}@example.test`,
        fullName: 'Unassigned',
        passwordHash: 'x',
      },
    })
  ).id;
  await owner.clientResponsibility.create({
    data: { tenantId, clientId, staffId, role: 'HAUPTBEARBEITER' },
  });
  contactId = (
    await owner.clientContact.create({
      data: { tenantId, clientId, email: `tax-contact-${stamp}@example.test`, fullName: 'Contact' },
    })
  ).id;
  inactiveContactId = (
    await owner.clientContact.create({
      data: {
        tenantId,
        clientId,
        email: `tax-inactive-${stamp}@example.test`,
        fullName: 'Inactive',
        active: false,
      },
    })
  ).id;
  registrationId = (
    await owner.clientTaxRegistration.create({
      data: {
        tenantId,
        clientId,
        label: 'Main',
        numberElster: '1112034567890',
        taxOfficeCode: '1112',
        isPrimary: true,
      },
    })
  ).id;
});
afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  if (foreignTenantId) await owner.tenant.delete({ where: { id: foreignTenantId } });
  await app.$disconnect();
  await owner.$disconnect();
});

describe('TAX-MASTER-DATA-001 PostgreSQL boundaries', () => {
  it('rejects missing active numbers, duplicate primary/number and cross-tenant client pairs', async () => {
    const base = { tenantId, clientId, label: 'Other' };
    await expect(owner.clientTaxRegistration.create({ data: { ...base } })).rejects.toThrow();
    await expect(
      owner.clientTaxRegistration.create({
        data: { ...base, numberElster: '1113034567890', taxOfficeCode: '1113', isPrimary: true },
      }),
    ).rejects.toThrow();
    await expect(
      owner.clientTaxRegistration.create({
        data: { ...base, numberElster: '1112034567890', taxOfficeCode: '1112' },
      }),
    ).rejects.toThrow();
    await expect(
      owner.clientTaxRegistration.create({
        data: {
          ...base,
          tenantId: foreignTenantId,
          numberElster: '1114034567890',
          taxOfficeCode: '1114',
        },
      }),
    ).rejects.toThrow();
  });
  it('permits own active portal reads but denies inactive contacts and canonical portal writes', async () => {
    expect(
      await asActor('CLIENT_CONTACT', contactId, (tx) => tx.clientTaxRegistration.count()),
    ).toBe(1);
    expect(
      await asActor('CLIENT_CONTACT', inactiveContactId, (tx) => tx.clientTaxRegistration.count()),
    ).toBe(0);
    await expect(
      asActor('CLIENT_CONTACT', contactId, (tx) =>
        tx.clientTaxRegistration.create({
          data: {
            tenantId,
            clientId,
            label: 'Forged',
            numberElster: '1114034567890',
            taxOfficeCode: '1114',
          },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await asActor('CLIENT_CONTACT', contactId, (tx) =>
        tx.clientTaxRegistration.updateMany({
          where: { id: registrationId },
          data: { label: 'Forged' },
        }),
      ),
    ).toEqual({ count: 0 });
  });
  it('enforces confidential staff access and tenant context for direct SQL-backed reads/writes', async () => {
    expect(await asActor('STAFF', staffId, (tx) => tx.clientTaxRegistration.count())).toBe(1);
    expect(await asActor('STAFF', otherStaffId, (tx) => tx.clientTaxRegistration.count())).toBe(0);
    expect(
      await asActor('STAFF', staffId, (tx) => tx.clientTaxRegistration.count(), foreignTenantId),
    ).toBe(0);
    expect(
      await asActor('STAFF', otherStaffId, (tx) =>
        tx.clientTaxRegistration.updateMany({
          where: { id: registrationId },
          data: { label: 'Forged' },
        }),
      ),
    ).toEqual({ count: 0 });
    expect(
      await asActor('STAFF', staffId, (tx) =>
        tx.clientTaxRegistration.updateMany({
          where: { id: registrationId },
          data: { taxOfficeName: 'Updated office' },
        }),
      ),
    ).toEqual({ count: 1 });
    await owner.tenantSetting.create({
      data: { tenantId, key: 'access', value: { clientAccessMode: 'RESTRICTED' } },
    });
    await expect(
      asActor('STAFF', otherStaffId, (tx) =>
        tx.clientTaxRegistration.create({
          data: {
            tenantId,
            clientId: otherClientId,
            label: 'Restricted',
            numberElster: '1115034567890',
            taxOfficeCode: '1115',
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('binds ELSTER history to the same client and retains queried numbers after tax redaction', async () => {
    const query = {
      tenantId,
      clientId,
      taxRegistrationId: registrationId,
      taxNumberSnapshot: '1112034567890',
      art: 'O',
      echtfall: false,
      ok: true,
      returnCode: 0,
      result: '<fixture />',
      requestedBy: staffId,
    };
    await expect(
      owner.elsterKontoabfrage.create({ data: { ...query, clientId: otherClientId } }),
    ).rejects.toThrow();
    const saved = await owner.elsterKontoabfrage.create({ data: query });
    await owner.clientTaxRegistration.update({
      where: { id: registrationId },
      data: {
        label: 'Anonymisiert',
        numberElster: null,
        taxOfficeCode: null,
        taxOfficeName: '',
        isPrimary: false,
        archivedAt: new Date(),
      },
    });
    expect(
      (await owner.elsterKontoabfrage.findUniqueOrThrow({ where: { id: saved.id } }))
        .taxNumberSnapshot,
    ).toBe('1112034567890');
    await expect(
      owner.clientTaxRegistration.update({
        where: { id: registrationId },
        data: { archivedAt: null },
      }),
    ).rejects.toThrow();
  });
});
