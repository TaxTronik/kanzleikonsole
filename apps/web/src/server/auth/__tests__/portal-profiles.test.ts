import { beforeEach, describe, expect, it, vi } from 'vitest';
// Fachkatalog: ACCESS-TENANT-RLS-001, CLIENT-MANDATE-LIFECYCLE-001

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  withTenantContext: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: m.withTenantContext,
}));

const tx = {
  clientContact: {
    findFirst: m.findFirst,
    findMany: m.findMany,
  },
};

import {
  findEligiblePortalProfilesByEmail,
  findPortalProfilesForContact,
  resolvePortalProfileSwitch,
} from '../portal-profiles';

const CONTACT = {
  id: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  fullName: 'Rey Koxha',
  email: 'rey@example.test',
  client: { name: 'Rey Koxha' },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.findFirst.mockResolvedValue({ email: CONTACT.email });
  m.findMany.mockResolvedValue([CONTACT]);
  m.withTenantContext.mockImplementation(
    async (_ctx: unknown, fn: (client: typeof tx) => unknown) => fn(tx),
  );
});

describe('Portal-Mehrfachprofile', () => {
  it('sucht ausschließlich im Tenant und nur freigegebene aktive Mandanten', async () => {
    const profiles = await findEligiblePortalProfilesByEmail({
      tenantId: 'tenant-1',
      email: 'REY@EXAMPLE.TEST',
    });

    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          email: 'rey@example.test',
          active: true,
          client: { allowActive: true, anonymizedAt: null, mandateEndedAt: null },
        },
      }),
    );
    expect(m.withTenantContext).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', actorId: null, actorType: 'SYSTEM' },
      expect.any(Function),
    );
    expect(profiles).toEqual([
      {
        contactId: CONTACT.id,
        clientId: CONTACT.clientId,
        clientName: CONTACT.client.name,
        contactName: CONTACT.fullName,
        email: CONTACT.email,
      },
    ]);
  });

  it('gleicht die verifizierte Session-E-Mail mit dem aktuellen DB-Kontakt ab', async () => {
    await findPortalProfilesForContact({
      tenantId: 'tenant-1',
      contactId: CONTACT.id,
      email: CONTACT.email,
    });

    expect(m.findFirst).toHaveBeenCalledWith({
      where: {
        id: CONTACT.id,
        tenantId: 'tenant-1',
        active: true,
        client: { allowActive: true, anonymizedAt: null, mandateEndedAt: null },
      },
      select: { email: true },
    });
    expect(m.withTenantContext).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', actorId: CONTACT.id, actorType: 'CLIENT_CONTACT' },
      expect.any(Function),
    );
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: CONTACT.email }) }),
    );
  });

  it('liefert ohne gültigen Ausgangskontakt keine umschaltbaren Profile', async () => {
    m.findFirst.mockResolvedValue(null);

    await expect(
      findPortalProfilesForContact({
        tenantId: 'tenant-1',
        contactId: CONTACT.id,
        email: CONTACT.email,
      }),
    ).resolves.toEqual([]);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it('lehnt ein Ziel außerhalb der Profile derselben E-Mail fail-closed ab', async () => {
    await expect(
      resolvePortalProfileSwitch({
        tenantId: 'tenant-1',
        currentContactId: CONTACT.id,
        email: CONTACT.email,
        targetContactId: '33333333-3333-4333-8333-333333333333',
      }),
    ).resolves.toBeNull();
  });
});
