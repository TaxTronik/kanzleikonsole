// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';
import { withTenantContext } from '../tenant-context';
import { prisma as appPrisma } from '../client';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let clientId: string;
let staffId: string;
let deadlineId: string;
let requestId: string;
let internalCommentId: string;
const notificationAttemptAt = new Date('2026-08-20T09:15:00.000Z');
const notificationRetryAt = new Date('2026-08-20T09:19:00.000Z');

beforeAll(async () => {
  const stamp = Date.now();
  const tenant = await owner.tenant.create({
    data: { slug: `tax-request-link-${stamp}`, name: 'Tax Request Link Test' },
  });
  tenantId = tenant.id;
  const staff = await owner.staffUser.create({
    data: {
      tenantId,
      email: `tax-request-link-${stamp}@test.local`,
      fullName: 'Tax Link Test',
      passwordHash: 'x',
    },
  });
  staffId = staff.id;
  const client = await owner.client.create({
    data: { tenantId, kind: 'JURPERS', name: 'Tax Link Mandant', allowActive: false },
  });
  clientId = client.id;
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId,
    clientId,
    verifiedBy: staffId,
    validUntil: new Date('2099-12-31T00:00:00.000Z'),
    registerNumber: `HRB TAX LINK ${stamp}`,
  });
  await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });

  const deadline = await owner.taxDeadline.create({
    data: {
      tenantId,
      clientId,
      kind: 'USTA_MONATLICH',
      period: `test-${stamp}`,
      dueDate: new Date('2099-12-31T00:00:00.000Z'),
    },
  });
  deadlineId = deadline.id;
  const request = await owner.request.create({
    data: {
      tenantId,
      clientId,
      title: 'Automatische Steuer-Anforderung',
      description: 'Konsistenztest',
      createdByStaff: staffId,
    },
  });
  requestId = request.id;
  const internalComment = await owner.requestInternalComment.create({
    data: {
      requestId,
      authorStaffId: staffId,
      authorName: 'Tax Link Test',
      body: 'Nur intern sichtbar',
    },
  });
  internalCommentId = internalComment.id;

  await owner.$transaction(async (tx) => {
    await tx.request.update({
      where: { id: requestId },
      data: { taxDeadlineId: deadlineId },
    });
    await tx.taxDeadline.update({
      where: { id: deadlineId },
      data: {
        requestId,
        autoRequestNotificationStatus: 'FAILED',
        autoRequestNotificationAttemptCount: 1,
        autoRequestNotificationLastAttemptAt: notificationAttemptAt,
        autoRequestNotificationNextAttemptAt: notificationRetryAt,
        autoRequestNotificationLastError: 'Testaufbau: eindeutiger technischer Fehlschlag.',
      },
    });
  });
});

afterAll(async () => {
  if (tenantId) await owner.tenant.deleteMany({ where: { id: tenantId } });
  await owner.$disconnect();
  await appPrisma.$disconnect();
});

describe('TaxDeadline/Request-Pointer-Invariante', () => {
  it('verwirft das einseitige Clear auf der Request-Seite am Transaktionscommit', async () => {
    await expect(
      owner.$transaction((tx) =>
        tx.request.update({ where: { id: requestId }, data: { taxDeadlineId: null } }),
      ),
    ).rejects.toThrow(/pointer mismatch/i);

    await expect(owner.request.findUnique({ where: { id: requestId } })).resolves.toMatchObject({
      taxDeadlineId: deadlineId,
    });
  });

  it('verwirft das einseitige Clear auf der Deadline-Seite am Transaktionscommit', async () => {
    await expect(
      owner.$transaction((tx) =>
        tx.taxDeadline.update({
          where: { id: deadlineId },
          data: { requestId: null },
        }),
      ),
    ).rejects.toThrow(/pointer mismatch/i);

    await expect(
      owner.taxDeadline.findUnique({ where: { id: deadlineId } }),
    ).resolves.toMatchObject({ requestId });
  });

  it('verwirft widersprüchliche Feldkombinationen je Benachrichtigungsstatus', async () => {
    await expect(
      owner.taxDeadline.update({
        where: { id: deadlineId },
        data: {
          autoRequestNotificationStatus: 'PROVIDER_ACCEPTED',
          autoRequestNotificationAcceptedAt: null,
          autoRequestNotificationLastError: null,
        },
      }),
    ).rejects.toThrow(/tax_deadline_notification_state_check/i);

    await expect(
      owner.taxDeadline.update({
        where: { id: deadlineId },
        data: {
          autoRequestNotificationStatus: 'FAILED',
          autoRequestNotificationAttemptCount: 3,
          autoRequestNotificationNextAttemptAt: notificationRetryAt,
          autoRequestNotificationLastError: 'Test: unzulässiger vierter Retry-Zustand.',
        },
      }),
    ).rejects.toThrow(/tax_deadline_notification_state_check/i);
  });

  it('blockiert Unlink und Purge während eines aktiven Versandclaims', async () => {
    await owner.taxDeadline.update({
      where: { id: deadlineId },
      data: {
        autoRequestNotificationStatus: 'UNKNOWN',
        autoRequestNotificationNextAttemptAt: null,
        autoRequestNotificationLastError: 'Versandversuch gestartet.',
      },
    });

    await expect(
      owner.$transaction(async (tx) => {
        await tx.request.update({ where: { id: requestId }, data: { taxDeadlineId: null } });
        await tx.$queryRaw(
          Prisma.sql`SELECT set_config('app.tax_deadline_notification_purge', 'on', true)`,
        );
        await tx.taxDeadline.update({
          where: { id: deadlineId },
          data: {
            requestId: null,
            autoRequestNotificationStatus: 'NOT_REQUIRED',
            autoRequestNotificationAttemptCount: 0,
            autoRequestNotificationLastAttemptAt: null,
            autoRequestNotificationNextAttemptAt: null,
            autoRequestNotificationAcceptedAt: null,
            autoRequestNotificationLastError: null,
            autoRequestNotificationEscalatedAt: null,
          },
        });
      }),
    ).rejects.toThrow(/notification attempt is in flight/i);

    await expect(owner.request.findUnique({ where: { id: requestId } })).resolves.toMatchObject({
      taxDeadlineId: deadlineId,
    });
    await owner.taxDeadline.update({
      where: { id: deadlineId },
      data: {
        autoRequestNotificationStatus: 'FAILED',
        autoRequestNotificationNextAttemptAt: notificationRetryAt,
        autoRequestNotificationLastError: 'Testaufbau: eindeutiger technischer Fehlschlag.',
      },
    });
  });

  it('bewahrt für einen terminalen Request den asymmetrischen ORPHANED-Rücklink', async () => {
    await expect(
      owner.$transaction(async (tx) => {
        await tx.request.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
        await tx.taxDeadline.update({
          where: { id: deadlineId },
          data: {
            requestId: null,
            autoRequestNotificationStatus: 'NOT_REQUIRED',
            autoRequestNotificationAttemptCount: 0,
            autoRequestNotificationLastAttemptAt: null,
            autoRequestNotificationNextAttemptAt: null,
            autoRequestNotificationAcceptedAt: null,
            autoRequestNotificationLastError: null,
            autoRequestNotificationEscalatedAt: null,
          },
        });
      }),
    ).resolves.toBeUndefined();

    await expect(owner.request.findUnique({ where: { id: requestId } })).resolves.toMatchObject({
      taxDeadlineId: deadlineId,
      status: 'CANCELLED',
    });
    await expect(
      owner.taxDeadline.findUnique({ where: { id: deadlineId } }),
    ).resolves.toMatchObject({
      requestId: null,
      autoRequestNotificationStatus: 'ORPHANED',
      autoRequestNotificationAttemptCount: 1,
      autoRequestNotificationLastAttemptAt: notificationAttemptAt,
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationAcceptedAt: null,
      autoRequestNotificationLastError: expect.stringMatching(
        /Testaufbau:.*vorheriger Benachrichtigungsstatus: FAILED/s,
      ),
      autoRequestNotificationEscalatedAt: null,
    });

    await expect(
      owner.taxDeadline.update({
        where: { id: deadlineId },
        data: {
          autoRequestNotificationAttemptCount: 2,
          autoRequestNotificationLastError: 'Nachträglich umgeschriebene Historie.',
        },
      }),
    ).rejects.toThrow(/orphaned.*history is immutable/i);

    await expect(
      owner.$transaction((tx) =>
        tx.request.update({ where: { id: requestId }, data: { status: 'OPEN' } }),
      ),
    ).rejects.toThrow(/pointer mismatch/i);
  });

  it('erlaubt nur dem expliziten Purge-Pfad die vollständige Neutralisierung', async () => {
    await expect(
      owner.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT set_config('app.current_tenant_id', ${tenantId}, true),
                   set_config('app.current_actor_id', ${staffId}, true),
                   set_config('app.current_actor_type', 'STAFF', true)
          `;
          // Frische isolierte DBs erben den produktiven Default-Grant nicht.
          // Der transaktionale Grant wird mit dem erwarteten Triggerfehler
          // zurückgerollt und bildet nur den regulären Runtime-Zugriff ab.
          await tx.$executeRawUnsafe(
            'GRANT SELECT, UPDATE ON public."tax_deadline" TO taxtronik_app',
          );
          await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
          // Ein frei setzbares Custom-GUC ist kein Autorisierungsnachweis. Der
          // Runtime-User darf den exklusiven Owner-Retentionpfad nicht imitieren.
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('app.tax_deadline_notification_purge', 'on', true)`,
          );
          await tx.taxDeadline.update({
            where: { id: deadlineId },
            data: {
              requestId: null,
              autoRequestNotificationStatus: 'NOT_REQUIRED',
              autoRequestNotificationAttemptCount: 0,
              autoRequestNotificationLastAttemptAt: null,
              autoRequestNotificationNextAttemptAt: null,
              autoRequestNotificationAcceptedAt: null,
              autoRequestNotificationLastError: null,
              autoRequestNotificationEscalatedAt: null,
            },
          });
        }),
    ).rejects.toThrow(/orphaned.*history is immutable/i);

    await expect(
      owner.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT set_config('app.tax_deadline_notification_purge', 'on', true)`,
        );
        await tx.taxDeadline.update({
          where: { id: deadlineId },
          data: {
            requestId: null,
            autoRequestNotificationStatus: 'NOT_REQUIRED',
            autoRequestNotificationAttemptCount: 0,
            autoRequestNotificationLastAttemptAt: null,
            autoRequestNotificationNextAttemptAt: null,
            autoRequestNotificationAcceptedAt: null,
            autoRequestNotificationLastError: null,
            autoRequestNotificationEscalatedAt: null,
          },
        });
        await tx.request.update({ where: { id: requestId }, data: { taxDeadlineId: null } });
      }),
    ).resolves.toBeUndefined();

    await expect(
      owner.taxDeadline.findUnique({ where: { id: deadlineId } }),
    ).resolves.toMatchObject({
      requestId: null,
      autoRequestNotificationStatus: 'NOT_REQUIRED',
      autoRequestNotificationAttemptCount: 0,
      autoRequestNotificationLastAttemptAt: null,
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationAcceptedAt: null,
      autoRequestNotificationLastError: null,
      autoRequestNotificationEscalatedAt: null,
    });
  });

  it('archiviert terminale Versandhistorie vor einer Neu-Materialisierung', async () => {
    const suffix = `archive-${Date.now()}`;
    const deadline = await owner.taxDeadline.create({
      data: {
        tenantId,
        clientId,
        kind: 'USTA_MONATLICH',
        period: suffix,
        dueDate: new Date('2099-11-30T00:00:00.000Z'),
      },
    });
    const request = await owner.request.create({
      data: {
        tenantId,
        clientId,
        title: 'Zu archivierende Auto-Anforderung',
        description: 'DB-Regression für Neu-Materialisierung',
        createdByStaff: staffId,
      },
    });
    await owner.$transaction(async (tx) => {
      await tx.request.update({
        where: { id: request.id },
        data: { taxDeadlineId: deadline.id },
      });
      await tx.taxDeadline.update({
        where: { id: deadline.id },
        data: {
          requestId: request.id,
          status: 'REMINDED',
          autoRequestNotificationStatus: 'FAILED',
          autoRequestNotificationAttemptCount: 1,
          autoRequestNotificationLastAttemptAt: notificationAttemptAt,
          autoRequestNotificationNextAttemptAt: notificationRetryAt,
          autoRequestNotificationLastError: 'Provider vor Neuplanung nicht erreichbar.',
        },
      });
    });

    await owner.$transaction(async (tx) => {
      await tx.request.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
      await tx.taxDeadline.delete({ where: { id: deadline.id } });
    });

    const archived = await owner.taxDeadlineNotificationHistory.findUniqueOrThrow({
      where: { originalDeadlineId: deadline.id },
    });
    expect(archived).toMatchObject({
      tenantId,
      originalDeadlineId: deadline.id,
      requestId: request.id,
      notificationStatus: 'FAILED',
      notificationAttemptCount: 1,
      notificationLastAttemptAt: notificationAttemptAt,
      notificationNextAttemptAt: notificationRetryAt,
      notificationErrorRecorded: true,
      archiveReason: 'TERMINAL_REQUEST_DEADLINE_REMOVED',
    });
    expect(archived.notificationLastErrorSha256).toHaveLength(32);
    expect(archived).not.toHaveProperty('clientId');
    expect(archived).not.toHaveProperty('kind');
    expect(archived).not.toHaveProperty('period');
    expect(archived).not.toHaveProperty('dueDate');
    expect(archived).not.toHaveProperty('notificationLastError');
    expect(JSON.stringify(archived)).not.toContain('Provider vor Neuplanung nicht erreichbar.');
    await expect(owner.request.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      taxDeadlineId: null,
      status: 'CANCELLED',
    });

    await expect(
      owner.taxDeadline.create({
        data: {
          tenantId,
          clientId,
          kind: 'USTA_MONATLICH',
          period: suffix,
          dueDate: new Date('2099-12-31T00:00:00.000Z'),
        },
      }),
    ).resolves.toMatchObject({ period: suffix });

    // Der technische Hilfsnachweis hat keinen eigenständigen, unbegrenzten
    // Lebenszyklus: ein früherer Request-Purge entfernt ihn per FK-CASCADE.
    await owner.request.delete({ where: { id: request.id } });
    await expect(
      owner.taxDeadlineNotificationHistory.findUnique({
        where: { originalDeadlineId: deadline.id },
      }),
    ).resolves.toBeNull();
  });

  it('erteilt taxtronik_app keinen Lesezugriff auf die interne Versandhistorie', async () => {
    await expect(
      withTenantContext(
        { tenantId, actorId: staffId, actorType: 'STAFF' },
        (tx) => tx.taxDeadlineNotificationHistory.findMany({ take: 1 }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('blockiert einen konkurrierenden Delete nach einem gewonnenen UNKNOWN-Claim', async () => {
    const suffix = `concurrency-${Date.now()}`;
    const deadline = await owner.taxDeadline.create({
      data: {
        tenantId,
        clientId,
        kind: 'USTA_QUARTAL',
        period: suffix,
        dueDate: new Date('2099-12-31T00:00:00.000Z'),
      },
    });
    const request = await owner.request.create({
      data: {
        tenantId,
        clientId,
        title: 'Concurrency Auto-Anforderung',
        description: 'UNKNOWN-Claim gegen Delete',
        createdByStaff: staffId,
      },
    });
    await owner.$transaction(async (tx) => {
      await tx.request.update({
        where: { id: request.id },
        data: { taxDeadlineId: deadline.id },
      });
      await tx.taxDeadline.update({
        where: { id: deadline.id },
        data: {
          requestId: request.id,
          status: 'REMINDED',
          autoRequestNotificationStatus: 'QUEUED',
          autoRequestNotificationNextAttemptAt: notificationRetryAt,
        },
      });
    });

    let signalClaimed!: () => void;
    let releaseClaim!: () => void;
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claimTransaction = owner.$transaction(async (tx) => {
      await tx.request.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
      await tx.taxDeadline.update({
        where: { id: deadline.id },
        data: {
          autoRequestNotificationStatus: 'UNKNOWN',
          autoRequestNotificationAttemptCount: 1,
          autoRequestNotificationLastAttemptAt: notificationAttemptAt,
          autoRequestNotificationNextAttemptAt: null,
          autoRequestNotificationLastError: 'Versandversuch gestartet.',
        },
      });
      signalClaimed();
      await release;
    });
    await claimed;

    const deleteOutcome = owner.taxDeadline.delete({ where: { id: deadline.id } }).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const beforeClaimCommit = await Promise.race([
      deleteOutcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    expect(beforeClaimCommit).toBeNull();

    releaseClaim();
    await claimTransaction;
    const deletion = await deleteOutcome;
    expect(deletion.ok).toBe(false);
    expect(String(deletion.error)).toMatch(/notification attempt is in flight/i);

    await owner.taxDeadline.update({
      where: { id: deadline.id },
      data: {
        autoRequestNotificationStatus: 'FAILED',
        autoRequestNotificationNextAttemptAt: notificationRetryAt,
        autoRequestNotificationLastError: 'Versand eindeutig fehlgeschlagen.',
      },
    });
    await owner.taxDeadline.delete({ where: { id: deadline.id } });
  });

  it('liefert interne Kommentare für STAFF, aber niemals für CLIENT_CONTACT', async () => {
    const staffRows = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) => tx.requestInternalComment.findMany({ where: { id: internalCommentId } }),
    );
    const portalRows = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'CLIENT_CONTACT' },
      (tx) => tx.requestInternalComment.findMany({ where: { id: internalCommentId } }),
    );

    expect(staffRows).toHaveLength(1);
    expect(portalRows).toEqual([]);
  });
});
