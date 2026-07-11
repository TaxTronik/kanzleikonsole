import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('DSGVO-Evidence-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let staffId: string;

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `test-dsgvo-evidence-${Date.now()}`, name: 'DSGVO Evidence Test' },
  });
  tenantId = tenant.id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `dsgvo-evidence-${Date.now()}@test.local`,
        fullName: 'DSGVO Test Staff',
        passwordHash: 'x',
      },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await owner.$disconnect();
});

const receivedAt = new Date('2026-07-01T00:00:00.000Z');
const responseSentAt = new Date('2026-07-10T00:00:00.000Z');

function baseData() {
  return {
    tenantId,
    type: 'ACCESS' as const,
    subjectType: 'EXTERNAL' as const,
    subjectEmail: 'person@example.com',
    subjectName: 'Betroffene Person',
    description: 'Auskunftsersuchen',
    receivedAt,
    dueDate: new Date('2026-08-01T00:00:00.000Z'),
    createdByStaff: staffId,
  };
}

describeWithDatabase('DSGVO-Abschlussnachweis (Migration 03510)', () => {
  it('blockiert Ablehnung ohne nachgewiesenen Antwortversand', async () => {
    await expect(
      owner.dsgvoRequest.create({
        data: {
          ...baseData(),
          status: 'REJECTED',
          rejectionReason: 'Identität konnte nicht bestätigt werden.',
          completedAt: new Date(),
          completedByStaff: staffId,
        },
      }),
    ).rejects.toThrow();
  });

  it('blockiert einen Antworttag vor dem Eingang', async () => {
    await expect(
      owner.dsgvoRequest.create({
        data: {
          ...baseData(),
          status: 'COMPLETED',
          notes: 'Auskunft vollständig bearbeitet.',
          responseSentAt: new Date('2026-06-30T00:00:00.000Z'),
          responseMethod: 'Portal',
          resultSha256: new Uint8Array(32),
          resultPreparedAt: new Date('2026-07-08T10:00:00.000Z'),
          resultPreparedBy: staffId,
          resultReviewedAt: new Date('2026-07-09T10:00:00.000Z'),
          resultReviewedBy: staffId,
          completedAt: new Date(),
          completedByStaff: staffId,
        },
      }),
    ).rejects.toThrow();
  });

  it('blockiert Ergebnis-Hashes mit falscher Länge', async () => {
    await expect(
      owner.dsgvoRequest.create({
        data: {
          ...baseData(),
          status: 'COMPLETED',
          notes: 'Auskunft vollständig bearbeitet.',
          responseSentAt,
          responseMethod: 'Portal',
          resultSha256: new Uint8Array(31),
          resultPreparedAt: new Date('2026-07-08T10:00:00.000Z'),
          resultPreparedBy: staffId,
          resultReviewedAt: new Date('2026-07-09T10:00:00.000Z'),
          resultReviewedBy: staffId,
          completedAt: new Date(),
          completedByStaff: staffId,
        },
      }),
    ).rejects.toThrow();
  });

  it('akzeptiert keine beliebige oder tenantfremde Ergebnisdokument-ID', async () => {
    await expect(
      owner.dsgvoRequest.create({
        data: {
          ...baseData(),
          status: 'COMPLETED',
          notes: 'Auskunft vollständig bearbeitet.',
          responseSentAt,
          responseMethod: 'Portal',
          resultDocumentId: '00000000-0000-0000-0000-000000000001',
          resultReviewedAt: new Date('2026-07-09T10:00:00.000Z'),
          resultReviewedBy: staffId,
          completedAt: new Date(),
          completedByStaff: staffId,
        },
      }),
    ).rejects.toThrow(/Ergebnisdokument/i);
  });

  it('friert einen belastbar abgeschlossenen Nachweis ein', async () => {
    const request = await owner.dsgvoRequest.create({
      data: {
        ...baseData(),
        status: 'COMPLETED',
        notes: 'Auskunft vollständig bearbeitet und geprüft.',
        responseSentAt,
        responseMethod: 'Mandantenportal',
        resultSha256: new Uint8Array(32),
        resultPreparedAt: new Date('2026-07-08T10:00:00.000Z'),
        resultPreparedBy: staffId,
        resultReviewedAt: new Date('2026-07-09T10:00:00.000Z'),
        resultReviewedBy: staffId,
        completedAt: new Date('2026-07-10T10:00:00.000Z'),
        completedByStaff: staffId,
      },
    });

    await expect(
      owner.dsgvoRequest.update({
        where: { id: request.id },
        data: { notes: 'Nachträglich verändert' },
      }),
    ).rejects.toThrow(/unveränderlich/i);
  });
});
