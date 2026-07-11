import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_SEED_GWG_LEGAL_ENTITY_SNAPSHOT, ensureDevSeedVerifiedGwgCheck } from '../../seeds/lib';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { PrismaClient } from '../prisma-client';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let clientId: string;
let staffId: string;

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tenant = await owner.tenant.create({
    data: { slug: `dev-seed-gwg-${suffix}`, name: 'Dev-Seed-GwG-Regression' },
  });
  tenantId = tenant.id;
  const staff = await owner.staffUser.create({
    data: {
      tenantId,
      email: `dev-seed-gwg-${suffix}@test.local`,
      fullName: 'Dev Seed Test',
      passwordHash: 'x',
    },
  });
  staffId = staff.id;
  const client = await owner.client.create({
    data: { tenantId, kind: 'JURPERS', name: 'Seed Fragment GmbH', allowActive: false },
  });
  clientId = client.id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.deleteMany({ where: { id: tenantId } });
  await owner.$disconnect();
});

describe('Dev-Seed GwG-Fail-closed-Reihenfolge', () => {
  it('ersetzt ein altes unvollständiges VERIFIED-Fragment und bleibt beim zweiten Lauf idempotent', async () => {
    const fragment = await owner.gwgCheck.create({
      data: {
        tenantId,
        clientId,
        status: 'VERIFIED',
        verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        verifiedBy: staffId,
        validUntil: null,
      },
    });

    await expect(
      owner.client.update({ where: { id: clientId }, data: { allowActive: true } }),
    ).rejects.toThrow(/vollständig verifizieren|verifizierten.*gwg_check/i);

    const repaired = await ensureDevSeedVerifiedGwgCheck(owner, {
      tenantId,
      clientId,
      verifiedBy: staffId,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });

    expect(
      await owner.gwgCheck.findUnique({ where: { id: fragment.id }, select: { status: true } }),
    ).toEqual({ status: 'EXPIRED' });
    expect(
      await owner.gwgCheck.findUnique({
        where: { id: repaired.id },
        select: {
          status: true,
          legalForm: true,
          registerNumber: true,
          registerAuthority: true,
          noRegisterEntry: true,
          representativeNames: true,
          ownershipStructureNotes: true,
        },
      }),
    ).toEqual({ status: 'VERIFIED', ...DEV_SEED_GWG_LEGAL_ENTITY_SNAPSHOT });

    await expect(
      owner.client.update({ where: { id: clientId }, data: { allowActive: true } }),
    ).resolves.toMatchObject({ allowActive: true });

    const secondRun = await ensureDevSeedVerifiedGwgCheck(owner, {
      tenantId,
      clientId,
      verifiedBy: staffId,
      now: new Date('2026-07-12T00:00:00.000Z'),
    });
    expect(secondRun.id).toBe(repaired.id);
    expect(await owner.gwgCheck.count({ where: { tenantId, clientId, status: 'VERIFIED' } })).toBe(
      1,
    );

    // Auch ein später hinzugekommenes Altfragment darf nicht als formal
    // VERIFIED neben dem weiterhin wiederverwendbaren Vollcheck stehen bleiben.
    const laterFragment = await owner.gwgCheck.create({
      data: {
        tenantId,
        clientId,
        status: 'VERIFIED',
        verifiedAt: new Date('2026-07-12T12:00:00.000Z'),
        verifiedBy: staffId,
      },
    });
    const thirdRun = await ensureDevSeedVerifiedGwgCheck(owner, {
      tenantId,
      clientId,
      verifiedBy: staffId,
      now: new Date('2026-07-13T00:00:00.000Z'),
    });
    expect(thirdRun.id).toBe(repaired.id);
    expect(
      await owner.gwgCheck.findUnique({
        where: { id: laterFragment.id },
        select: { status: true },
      }),
    ).toEqual({ status: 'EXPIRED' });
    expect(await owner.gwgCheck.count({ where: { tenantId, clientId, status: 'VERIFIED' } })).toBe(
      1,
    );
    expect(
      await owner.client.findUnique({ where: { id: clientId }, select: { allowActive: true } }),
    ).toEqual({ allowActive: true });
  });
});
