import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('GwG-Anforderungs-Lifecycle-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId = '';
let clientId = '';
let staffId = '';
let idDocumentId = '';

describeWithDatabase('GwG-Ausweisdokument-Anforderungs-Lifecycle', () => {
  beforeAll(async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const tenant = await db.tenant.create({
      data: { slug: `gwg-request-lifecycle-${suffix}`, name: 'GwG Request Lifecycle Test' },
    });
    tenantId = tenant.id;
    staffId = (
      await db.staffUser.create({
        data: {
          tenantId,
          email: `gwg-request-lifecycle-${suffix}@example.com`,
          fullName: 'GwG Request Lifecycle Staff',
          passwordHash: 'x',
          active: true,
        },
      })
    ).id;
    clientId = (
      await db.client.create({
        data: {
          tenantId,
          kind: 'JURPERS',
          name: 'GwG Request Lifecycle GmbH',
          allowActive: false,
        },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(db, {
      tenantId,
      clientId,
      verifiedBy: staffId,
      validUntil: new Date('2099-12-31T00:00:00.000Z'),
      registerNumber: `HRB GWG REQUEST ${suffix}`,
    });
    await db.client.update({ where: { id: clientId }, data: { allowActive: true } });
    idDocumentId = (
      await db.gwgIdDocument.findFirstOrThrow({
        where: { check: { clientId } },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) await db.tenant.deleteMany({ where: { id: tenantId } });
    await db.$disconnect();
  });

  it('erlaubt nach CLOSED eine neue Auto-Anforderung und blockiert nur parallele aktive Duplikate', async () => {
    const historic = await db.request.create({
      data: {
        tenantId,
        clientId,
        title: 'Historische Ausweisanforderung',
        description: 'Bereits erledigte Erneuerungsrunde',
        status: 'CLOSED',
        closedAt: new Date('2024-01-01T00:00:00.000Z'),
        closedByStaff: staffId,
        createdByStaff: staffId,
        linkedGwgIdDocumentId: idDocumentId,
      },
    });
    const secondHistoric = await db.request.create({
      data: {
        tenantId,
        clientId,
        title: 'Zweite historische Ausweisanforderung',
        description: 'Auch dieser Herkunftslink muss erhalten bleiben',
        status: 'CLOSED',
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedByStaff: staffId,
        createdByStaff: staffId,
        linkedGwgIdDocumentId: idDocumentId,
      },
    });

    const created = await db.request.createMany({
      data: [
        {
          tenantId,
          clientId,
          title: 'Neue automatische Ausweisanforderung',
          description: 'Aktuelle Erneuerungsrunde',
          status: 'OPEN',
          createdByStaff: staffId,
          linkedGwgIdDocumentId: idDocumentId,
        },
      ],
      skipDuplicates: true,
    });
    expect(created.count).toBe(1);

    const linked = await db.request.findMany({
      where: { linkedGwgIdDocumentId: idDocumentId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true },
    });
    expect(linked).toHaveLength(3);
    expect(linked).toEqual(
      expect.arrayContaining([
        { id: historic.id, status: 'CLOSED' },
        { id: secondHistoric.id, status: 'CLOSED' },
        expect.objectContaining({ status: 'OPEN' }),
      ]),
    );

    await expect(
      db.request.createMany({
        data: [
          {
            tenantId,
            clientId,
            title: 'Paralleles Duplikat',
            description: 'Muss am Race-Backstop scheitern',
            status: 'IN_PROGRESS',
            createdByStaff: staffId,
            linkedGwgIdDocumentId: idDocumentId,
          },
        ],
        skipDuplicates: true,
      }),
    ).resolves.toEqual({ count: 0 });

    await expect(
      db.request.update({ where: { id: historic.id }, data: { status: 'OPEN' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
