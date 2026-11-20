import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { dbAbgewiesen } from '../testing/db-fehler';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('GwG-Erstprüfungs-Retention-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

const OLD = new Date('2015-06-01T00:00:00.000Z');
const PAST_RETENTION = new Date('2021-01-01T00:00:00.000Z');

let tenantId = '';
let staffId = '';

async function setStaffContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
  await tx.$queryRawUnsafe("SELECT set_config('app.current_actor_type', 'STAFF', true)");
  await tx.$queryRawUnsafe("SELECT set_config('app.current_actor_id', $1, true)", staffId);
}

async function createNeverEstablishedCase(
  tx: Prisma.TransactionClient,
  status: 'DRAFT' | 'IN_REVIEW',
  anchors: { mandateEndedAt?: Date; findingAt?: Date } = {},
) {
  await setStaffContext(tx);
  const client = await tx.client.create({
    data: {
      tenantId,
      kind: 'JURPERS',
      name: `Nie etablierte ${status} GmbH`,
      allowActive: false,
      mandateEndedAt: anchors.mandateEndedAt,
      createdAt: OLD,
    },
  });
  const check = await tx.gwgCheck.create({
    data: {
      tenantId,
      clientId: client.id,
      status,
      validUntil: null,
      createdAt: OLD,
      updatedAt: OLD,
    },
  });
  const invite = await tx.gwgOnboardingInvite.create({
    data: {
      tenantId,
      clientId: client.id,
      gwgCheckId: check.id,
      inviteEmail: `${status.toLowerCase()}-${Date.now()}@example.com`,
      inviteName: `${status} Erstprüfung`,
      tokenHash: `${status.toLowerCase()}-${crypto.randomUUID()}`,
      expiresAt: OLD,
      status: 'EXPIRED',
      createdByStaff: staffId,
      createdAt: OLD,
      updatedAt: OLD,
    },
  });

  const document = await tx.document.create({
    data: {
      tenantId,
      clientId: client.id,
      gwgOnboardingInviteId: invite.id,
      title: `${status} Altbeleg`,
      classification: 'GWG_EVIDENCE',
      mimeType: 'application/pdf',
      retentionUntil: PAST_RETENTION,
      createdAt: anchors.findingAt ?? OLD,
    },
  });
  await tx.documentVersion.create({
    data: {
      documentId: document.id,
      versionNo: 1,
      storageBucket: 'gwg-retention-test',
      storageKey: `gwg-retention-test/${document.id}`,
      storageVersionId: `version-${document.id}`,
      sha256: Buffer.alloc(32, status === 'DRAFT' ? 0x41 : 0x42),
      sizeBytes: 1n,
      immutable: true,
      scanStatus: 'CLEAN',
      scanCompletedAt: OLD,
      createdById: staffId,
      createdAt: OLD,
    },
  });
  await tx.document.update({
    where: { id: document.id },
    data: {
      gwgDestructionRequestedAt: new Date(),
      gwgDestructionRequestedBy: staffId,
    },
  });
  return { client, check, invite, document };
}

describeWithDatabase('GwG-Retention nie etablierter offener Erstprüfungen', () => {
  beforeAll(async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const tenant = await db.tenant.create({
      data: { slug: `gwg-open-retention-${suffix}`, name: 'GwG Open Retention Test' },
    });
    tenantId = tenant.id;
    staffId = (
      await db.staffUser.create({
        data: {
          tenantId,
          email: `gwg-open-retention-${suffix}@example.com`,
          fullName: 'GwG Retention Staff',
          passwordHash: 'x',
          active: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) await db.tenant.deleteMany({ where: { id: tenantId } });
    await db.$disconnect();
  });

  for (const status of ['DRAFT', 'IN_REVIEW'] as const) {
    it(`vernichtet fälligen Beleg und danach die nie verifizierte ${status}-Erstprüfung`, async () => {
      const fixture = await db.$transaction((tx) => createNeverEstablishedCase(tx, status));

      const deletedVersions = await db.$transaction(async (tx) => {
        await setStaffContext(tx);
        const rows = await tx.$queryRaw<Array<{ deleted: number }>>`
          SELECT app.destroy_gwg_document_versions(${fixture.document.id}::uuid) AS deleted
        `;
        return rows[0]?.deleted;
      });
      expect(deletedVersions).toBe(1);
      expect(await db.documentVersion.count({ where: { documentId: fixture.document.id } })).toBe(
        0,
      );
      expect(
        await db.document.findUnique({
          where: { id: fixture.document.id },
          select: { gwgDestroyedAt: true, deletedAt: true },
        }),
      ).toEqual({ gwgDestroyedAt: expect.any(Date), deletedAt: expect.any(Date) });

      const destroyed = await db.$transaction(async (tx) => {
        await setStaffContext(tx);
        const rows = await tx.$queryRaw<Array<{ result: { status: string } }>>`
          SELECT app.destroy_gwg_check(${fixture.check.id}::uuid) AS result
        `;
        return rows[0]?.result;
      });
      expect(destroyed?.status).toBe(status);
      expect(
        await db.gwgCheck.findUnique({
          where: { id: fixture.check.id },
          select: { destroyedAt: true, status: true },
        }),
      ).toEqual({ destroyedAt: expect.any(Date), status });
    });
  }

  it.each(['Mandatsende', 'Feststellung'])(
    'GWG-RETENTION-DESTRUCTION-001: %s in der Berliner Neujahrsstunde sperrt Beleg und Check',
    async (quelle) => {
      const jahr = new Date().getUTCFullYear() - 6;
      const anker = new Date(`${jahr}-12-31T23:30:00Z`);
      const mandateEndedAt = quelle === 'Mandatsende' ? anker : undefined;
      for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
        const frist = { sqlState: '23514', meldung: /fünfjährige GwG-Aufbewahrungsfrist/ };
        await dbAbgewiesen(
          db.$transaction(async (tx) => {
            const testfall = await createNeverEstablishedCase(tx, 'DRAFT', {
              mandateEndedAt,
              findingAt: anker,
            });
            await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
            return tx.$queryRaw`SELECT app.assert_gwg_document_destruction_due(${testfall.document.id}::uuid)::text`;
          }),
          frist,
        );
        await dbAbgewiesen(
          db.$transaction(async (tx) => {
            await setStaffContext(tx);
            const client = await tx.client.create({
              data: {
                tenantId,
                kind: 'JURPERS',
                name: 'Stichtag',
                allowActive: false,
                mandateEndedAt,
              },
            });
            const check = await tx.gwgCheck.create({
              data: {
                tenantId,
                clientId: client.id,
                status: 'REJECTED',
                createdAt: OLD,
                updatedAt: mandateEndedAt ? OLD : anker,
              },
            });
            await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
            return tx.$queryRaw`SELECT app.destroy_gwg_check(${check.id}::uuid)`;
          }),
          frist,
        );
      }
    },
  );

  it('blockiert eine DRAFT-Prüfung einer bereits etablierten Beziehung ohne Mandatsende', async () => {
    const client = await db.client.create({
      data: {
        tenantId,
        kind: 'JURPERS',
        name: 'Historisch etablierte GmbH',
        allowActive: false,
        onboardingCompletedAt: OLD,
        createdAt: OLD,
      },
    });
    const check = await db.gwgCheck.create({
      data: {
        tenantId,
        clientId: client.id,
        status: 'DRAFT',
        validUntil: null,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });

    await dbAbgewiesen(
      db.$transaction(async (tx) => {
        await setStaffContext(tx);
        return tx.$queryRaw`SELECT app.destroy_gwg_check(${check.id}::uuid)`;
      }),
      /etablierte|Mandatsende/i,
    );
    expect(
      await db.gwgCheck.findUnique({ where: { id: check.id }, select: { destroyedAt: true } }),
    ).toEqual({ destroyedAt: null });
  });
});
