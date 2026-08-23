import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Bescheid-Nachweis-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let clientId: string;
let staffId: string;
let counter = 0;

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `test-tax-notice-evidence-${Date.now()}`, name: 'Bescheid-Nachweis Test' },
  });
  tenantId = tenant.id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `tax-notice-evidence-${Date.now()}@test.local`,
        fullName: 'Bescheid Test Staff',
        passwordHash: 'x',
      },
    })
  ).id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Bescheid-Testmandant' },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await owner.$disconnect();
});

function baseNotice() {
  counter += 1;
  return {
    tenantId,
    clientId,
    kind: 'EST' as const,
    period: `2026-${counter}`,
    noticeDate: new Date('2026-06-01T00:00:00.000Z'),
    createdByStaff: staffId,
  };
}

describeWithDatabase('Bescheid-Ereignisnachweise (Migration 03500)', () => {
  it('erzwingt die historische §122a-Evidenz und verwendet im Ausnahmefall den Abruf', async () => {
    const normal = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        period: `retrieval-normal-${counter}`,
        noticeDate: new Date('2025-01-10T00:00:00.000Z'),
        deliveryMethod: 'DATA_RETRIEVAL',
        retrievalIssuedAt: new Date('2025-01-09T00:00:00.000Z'),
        retrievalNotificationDate: new Date('2025-01-13T00:00:00.000Z'),
      },
    });
    expect(normal.appealDeadline?.toISOString().slice(0, 10)).toBe('2025-02-17');

    const disputed = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        period: `retrieval-disputed-${counter}`,
        noticeDate: new Date('2025-01-10T00:00:00.000Z'),
        deliveryMethod: 'DATA_RETRIEVAL',
        retrievalIssuedAt: new Date('2025-01-09T00:00:00.000Z'),
        retrievalNotificationDate: new Date('2025-01-13T00:00:00.000Z'),
        retrievalNotificationDisputedOrLate: true,
        retrievedAt: new Date('2025-01-20T00:00:00.000Z'),
      },
    });
    expect(disputed.appealDeadline?.toISOString().slice(0, 10)).toBe('2025-02-20');
  });

  it('führt bei bestrittenem Zugang ohne Abruf noch keine Einspruchsfrist', async () => {
    const notServed = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        period: `retrieval-not-served-${counter}`,
        noticeDate: new Date('2025-01-10T00:00:00.000Z'),
        deliveryMethod: 'DATA_RETRIEVAL',
        retrievalIssuedAt: new Date('2025-01-09T00:00:00.000Z'),
        retrievalNotificationDate: new Date('2025-01-13T00:00:00.000Z'),
        retrievalNotificationDisputedOrLate: true,
      },
    });

    expect(notServed.appealDeadline).toBeNull();
  });

  it('entscheidet den 2026-Cutover nach Erlass statt Bereitstellung', async () => {
    const oldLaw = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        period: `retrieval-issued-2025-${counter}`,
        noticeDate: new Date('2026-01-02T00:00:00.000Z'),
        deliveryMethod: 'DATA_RETRIEVAL',
        retrievalIssuedAt: new Date('2025-12-31T00:00:00.000Z'),
        retrievalNotificationDate: new Date('2026-01-03T00:00:00.000Z'),
      },
    });
    const newLaw = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        period: `retrieval-issued-2026-${counter}`,
        noticeDate: new Date('2026-01-02T00:00:00.000Z'),
        deliveryMethod: 'DATA_RETRIEVAL',
        retrievalIssuedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    expect(oldLaw.appealDeadline?.toISOString().slice(0, 10)).toBe('2026-02-07');
    expect(newLaw.appealDeadline?.toISOString().slice(0, 10)).toBe('2026-02-06');
  });

  it('wendet die Vier-Tage-Änderung ab Versand der Benachrichtigung 2025 an', async () => {
    const boundary = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        period: `retrieval-notification-2025-${counter}`,
        noticeDate: new Date('2024-12-31T00:00:00.000Z'),
        deliveryMethod: 'DATA_RETRIEVAL',
        retrievalIssuedAt: new Date('2024-12-30T00:00:00.000Z'),
        retrievalNotificationDate: new Date('2025-01-03T00:00:00.000Z'),
      },
    });

    expect(boundary.appealDeadline?.toISOString().slice(0, 10)).toBe('2025-02-07');
  });

  it('reserviert den undokumentierten Legacy-Fallback ausschließlich für den Backfill', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          period: `retrieval-forged-legacy-${counter}`,
          noticeDate: new Date('2025-01-10T00:00:00.000Z'),
          deliveryMethod: 'DATA_RETRIEVAL',
          retrievalNotificationLegacyFallback: true,
        },
      }),
    ).rejects.toThrow(/reserved for migrated records/i);
  });

  it('blockiert den Statusfortschritt eines offenen Altbestands ohne Einspruchsnachweis', async () => {
    const notice = await owner.taxNotice.create({
      data: { ...baseNotice(), status: 'ABGEHOLFEN' },
    });

    await expect(
      owner.taxNotice.update({
        where: { id: notice.id },
        data: {
          status: 'RECHTSKRAEFTIG',
          legalFinalAt: new Date('2026-06-20T00:00:00.000Z'),
          legalFinalBy: staffId,
        },
      }),
    ).rejects.toThrow(/appeal filing evidence/i);

    await owner.taxNotice.update({
      where: { id: notice.id },
      data: {
        appealFiledAt: new Date('2026-06-05T00:00:00.000Z'),
        appealFiledBy: staffId,
        appealResolvedAt: new Date('2026-06-12T00:00:00.000Z'),
      },
    });

    await expect(
      owner.taxNotice.update({
        where: { id: notice.id },
        data: {
          status: 'RECHTSKRAEFTIG',
          legalFinalAt: new Date('2026-06-20T00:00:00.000Z'),
          legalFinalBy: staffId,
        },
      }),
    ).resolves.toMatchObject({ status: 'RECHTSKRAEFTIG' });
  });

  it('lässt eine legacy Klage nicht ohne bestätigte Einspruchskette abschließen', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        status: 'KLAGE',
        appealDecisionReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
        appealDecisionLegalRemedyInstructionValid: true,
        klageDeadline: new Date('2026-07-10T00:00:00.000Z'),
        klageFiledAt: new Date('2026-06-15T00:00:00.000Z'),
        klageFiledBy: staffId,
      },
    });

    await expect(
      owner.taxNotice.update({
        where: { id: notice.id },
        data: {
          status: 'RECHTSKRAEFTIG',
          legalFinalAt: new Date('2026-06-25T00:00:00.000Z'),
          legalFinalBy: staffId,
        },
      }),
    ).rejects.toThrow(/appeal filing evidence/i);
  });

  it('blockiert einen Rechtskrafttag vor dem Bescheiddatum', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          status: 'RECHTSKRAEFTIG',
          legalFinalAt: new Date('2026-05-31T00:00:00.000Z'),
          legalFinalBy: staffId,
        },
      }),
    ).rejects.toThrow();
  });
});
