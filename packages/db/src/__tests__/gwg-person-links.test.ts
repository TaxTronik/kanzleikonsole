import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
const enabled = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !enabled)
  throw new Error('GWG-PERSON-LINKS-001 needs DATABASE_URL in CI.');
const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
(enabled ? describe : describe.skip)('GWG-PERSON-LINKS-001 database boundaries', () => {
  let tenantId: string;
  let staffId: string;
  let clientA: string;
  let clientB: string;
  let checkA: string;
  let checkB: string;
  let anchorA: string;
  let anchorB: string;
  beforeAll(async () => {
    const tenant = await db.tenant.create({
      data: { slug: `person-links-${Date.now()}`, name: 'Person links test' },
    });
    tenantId = tenant.id;
    staffId = (
      await db.staffUser.create({
        data: {
          tenantId,
          email: `links-${Date.now()}@example.test`,
          fullName: 'Staff',
          passwordHash: 'x',
        },
      })
    ).id;
    clientA = (await db.client.create({ data: { tenantId, kind: 'JURPERS', name: 'A' } })).id;
    clientB = (await db.client.create({ data: { tenantId, kind: 'JURPERS', name: 'B' } })).id;
    checkA = (await db.gwgCheck.create({ data: { tenantId, clientId: clientA } })).id;
    checkB = (await db.gwgCheck.create({ data: { tenantId, clientId: clientB } })).id;
    anchorA = (
      await db.gwgBeneficialOwner.create({ data: { gwgCheckId: checkA, fullName: 'Same Name' } })
    ).personAnchorId!;
    anchorB = (
      await db.gwgBeneficialOwner.create({ data: { gwgCheckId: checkB, fullName: 'Same Name' } })
    ).personAnchorId!;
  });
  afterAll(async () => {
    if (tenantId) await db.tenant.delete({ where: { id: tenantId } });
    await db.$disconnect();
  });
  it('assigns different local anchors to identical names, and one anchor to explicit double roles', async () => {
    expect(anchorA).not.toBe(anchorB);
    const owner = await db.gwgBeneficialOwner.findFirstOrThrow({ where: { gwgCheckId: checkA } });
    const rep = await db.gwgRepresentative.create({
      data: {
        gwgCheckId: checkA,
        fullName: owner.fullName,
        position: 0,
        linkedBeneficialOwnerId: owner.id,
      },
    });
    expect(rep.personAnchorId).toBe(anchorA);
  });
  it('rejects cross-mandate anchor reuse while permitting same-mandate next-check lineage', async () => {
    await expect(
      db.gwgBeneficialOwner.create({
        data: { gwgCheckId: checkB, fullName: 'Other', personAnchorId: anchorA },
      }),
    ).rejects.toThrow();
    const next = await db.gwgCheck.create({ data: { tenantId, clientId: clientA } });
    const owner = await db.gwgBeneficialOwner.create({
      data: { gwgCheckId: next.id, fullName: 'Local correction', personAnchorId: anchorA },
    });
    expect(owner.personAnchorId).toBe(anchorA);
    expect(
      (await db.gwgBeneficialOwner.findFirstOrThrow({ where: { gwgCheckId: checkB } })).fullName,
    ).toBe('Same Name');
  });
  it('removes cross-mandate links on anonymization without editing retained professional snapshots', async () => {
    const [fromAnchorId, toAnchorId] = [anchorA, anchorB].sort();
    await db.gwgPersonLink.create({
      data: { tenantId, fromAnchorId: fromAnchorId!, toAnchorId: toAnchorId!, createdBy: staffId },
    });
    await db.client.update({ where: { id: clientA }, data: { anonymizedAt: new Date() } });
    expect(await db.gwgPersonLink.count({ where: { tenantId } })).toBe(0);
    expect(await db.gwgBeneficialOwner.count({ where: { gwgCheckId: checkA } })).toBe(1);
  });
});
