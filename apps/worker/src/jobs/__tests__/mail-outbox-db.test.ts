// =============================================================================
// F-08: Mail-Outbox-Zustellung gegen echtes PostgreSQL.
//
// Belegt, was der Mock-Test nicht prüfen kann: Claim- und Terminal-CAS,
// Zeitplan- und Secret-CHECKs der Migration, das Entfernen von Payload und
// Secret im Terminalstatus, den Backoff über einen zweiten Lauf und die
// Kanzlei-Benachrichtigung über notify() in der Tenant-Transaktion. Versand
// (SMTP/n8n) ist eine Attrappe. Nur mit ausdrücklichem Opt-in im db-Job
// (WORKER_DB_TEST=1). Eigener Tenant, der am Ende samt Kaskade gelöscht wird;
// die Läufe sind auf ihn begrenzt, damit fremde Testreste unberührt bleiben.
// Folgebefund F-08: Die Aufträge verweisen auf eine echte, abholbereite
// Anlieferung; ist sie abgeholt, verwirft der Worker den Auftrag als SKIPPED.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueDirectMailTx, type MailOutboxTarget } from '@taxtronik/mail/outbox';

// B-02: lokal per WORKER_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  let url: URL;
  try {
    url = new URL(process.env['DATABASE_URL'] ?? '');
  } catch {
    throw new Error('WORKER_DB_TEST requires a valid DATABASE_URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname.length < 2 ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('WORKER_DB_TEST requires a loopback PostgreSQL DATABASE_URL.');
  }
}

vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prismaOwner } from '../../prisma-owner';
import { withWorkerTenantContext } from '../../tenant-context';
import { notify } from '../../notify';
import {
  MAIL_OUTBOX_MAX_ATTEMPTS,
  MAIL_OUTBOX_RESEND_WINDOW_DAYS,
  processMailOutbox,
  type MailOutboxDeliveryDeps,
} from '../mail-outbox';

const describeDb = enabled ? describe : describe.skip;
const LINK = 'https://portal.example.test/gwg-onboarding?token=db-test-token';

describeDb('F-08 mail-outbox-deliver against PostgreSQL', () => {
  let tenantId = '';
  let clientId = '';
  let staffId = '';
  let handoverId = '';
  const sendTemplateMail = vi.fn();
  const deps: MailOutboxDeliveryDeps = {
    db: prismaOwner,
    runAtomic: (tenant, fn) => withWorkerTenantContext(tenant, fn),
    sendTemplateMail,
    notifyClientContacts: vi.fn(),
    loadAttachment: vi.fn(),
    notifyStaff: (tx, input) => notify(tx, input),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  function target(): MailOutboxTarget {
    return {
      tenantId,
      clientId,
      purpose: 'handover-ready',
      resource: { type: 'client_handover', id: handoverId },
      staffHref: `/staff/clients/${clientId}`,
    };
  }

  async function enqueue(): Promise<string> {
    return withWorkerTenantContext(tenantId, (tx) =>
      enqueueDirectMailTx(tx, target(), {
        slug: 'handover-ready',
        to: 'max@example.test',
        vars: { label: 'Belege' },
        secretVars: { link: LINK },
        fallback: { subject: 'Abholbereit', bodyMd: '{{label}} {{link}}' },
      }),
    );
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await prismaOwner.tenant.create({ data: { slug: `f08-${suffix}`, name: 'F-08 outbox' } })
    ).id;
    clientId = (
      await prismaOwner.client.create({
        data: { tenantId, name: 'Synthetic F-08 client', kind: 'NATPERS' },
      })
    ).id;
    staffId = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `f08-${suffix}@example.test`,
          fullName: 'F-08 Outbox',
          passwordHash: 'synthetic',
        },
      })
    ).id;
    handoverId = (
      await prismaOwner.clientHandover.create({
        data: { tenantId, clientId, label: 'Belege', createdByStaff: staffId },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) await prismaOwner.tenant.delete({ where: { id: tenantId } });
    await prismaOwner.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await prismaOwner.mailOutbox.deleteMany({ where: { tenantId } });
    await prismaOwner.notification.deleteMany({ where: { tenantId } });
    await prismaOwner.clientHandover.update({
      where: { id: handoverId },
      data: { status: 'READY' },
    });
  });

  it('wiederholt eine Ablehnung nach Backoff und leert Payload und Secret im Erfolg', async () => {
    const id = await enqueue();
    sendTemplateMail.mockResolvedValueOnce({
      ok: false,
      sentViaTemplate: false,
      uncertainFailure: false,
    });

    const first = await processMailOutbox(deps, { tenantId });
    const retry = await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } });
    expect(first.retryPending).toBe(1);
    expect(retry).toMatchObject({ status: 'RETRY_PENDING', attemptCount: 1 });
    expect(retry.secretVarsEnc).not.toBeNull();
    expect(retry.nextAttemptAt!.getTime() - retry.lastAttemptAt!.getTime()).toBe(60_000);

    // Vor Ablauf des Backoffs bleibt der Auftrag liegen.
    expect((await processMailOutbox(deps, { tenantId })).processed).toBe(0);

    sendTemplateMail.mockResolvedValueOnce({
      ok: true,
      sentViaTemplate: false,
      uncertainFailure: false,
    });
    const second = await processMailOutbox(deps, {
      tenantId,
      now: new Date(retry.nextAttemptAt!.getTime() + 1_000),
    });
    const done = await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } });

    expect(second.providerAccepted).toBe(1);
    expect(sendTemplateMail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId,
        clientId,
        to: 'max@example.test',
        vars: { label: 'Belege', link: LINK },
      }),
    );
    expect(done).toMatchObject({
      status: 'PROVIDER_ACCEPTED',
      attemptCount: 2,
      payload: {},
      secretVarsEnc: null,
      nextAttemptAt: null,
      recipientsAttempted: 1,
      recipientsAccepted: 1,
    });
    expect(done.acceptedAt).toEqual(done.lastAttemptAt);
    expect(await prismaOwner.notification.count({ where: { tenantId } })).toBe(0);
  });

  it('beendet nach dem letzten Versuch mit FAILED und benachrichtigt die Kanzlei', async () => {
    const id = await enqueue();
    await prismaOwner.mailOutbox.update({
      where: { id },
      data: { status: 'RETRY_PENDING', attemptCount: MAIL_OUTBOX_MAX_ATTEMPTS - 1 },
    });
    sendTemplateMail.mockResolvedValueOnce({
      ok: false,
      sentViaTemplate: true,
      uncertainFailure: false,
    });

    const stats = await processMailOutbox(deps, { tenantId });

    expect(stats.escalated).toBe(1);
    const failed = await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } });
    // C4: Inhalt und Secret bleiben für „Erneut senden" erhalten (Secret-CHECK erlaubt FAILED).
    expect(failed).toMatchObject({ status: 'FAILED', nextAttemptAt: null });
    expect(failed.payload).toMatchObject({ slug: 'handover-ready' });
    expect(failed.secretVarsEnc).not.toBeNull();
    expect(
      await prismaOwner.notification.findMany({
        where: { tenantId },
        select: { kind: true, clientId: true, resourceType: true, resourceId: true, href: true },
      }),
    ).toEqual([
      {
        kind: 'SYSTEM_MAIL_FAILED',
        clientId,
        resourceType: 'client',
        resourceId: clientId,
        href: `/staff/clients/${clientId}`,
      },
    ]);
  });

  it('eskaliert einen hängenden Versuch als UNKNOWN, ohne erneut zu senden', async () => {
    const id = await enqueue();
    await prismaOwner.mailOutbox.update({
      where: { id },
      data: {
        status: 'SENDING',
        attemptCount: 1,
        nextAttemptAt: null,
        lastAttemptAt: new Date(Date.now() - 31 * 60_000),
      },
    });

    const stats = await processMailOutbox(deps, { tenantId });

    expect(stats).toMatchObject({ escalated: 1, processed: 0 });
    expect(sendTemplateMail).not.toHaveBeenCalled();
    const unknown = await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } });
    expect(unknown.status).toBe('UNKNOWN');
    expect(unknown.payload).toMatchObject({ slug: 'handover-ready' });
    expect(unknown.secretVarsEnc).not.toBeNull();
    expect(await prismaOwner.notification.count({ where: { tenantId } })).toBe(1);
  });

  it('verwirft den Auftrag ohne Versand, wenn die Unterlagen bereits abgeholt sind', async () => {
    const id = await enqueue();
    await prismaOwner.clientHandover.update({
      where: { id: handoverId },
      data: { status: 'PICKED_UP' },
    });

    const stats = await processMailOutbox(deps, { tenantId });

    expect(stats).toMatchObject({ skipped: 1, processed: 0, escalated: 0 });
    expect(sendTemplateMail).not.toHaveBeenCalled();
    // SKIPPED erfüllt Zeitplan- und Secret-CHECK: Inhalt und Secret sind entfernt.
    expect(await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'SKIPPED',
      attemptCount: 0,
      payload: {},
      secretVarsEnc: null,
      nextAttemptAt: null,
      lastError: 'Nicht versendet: Die Unterlagen wurden bereits abgeholt.',
    });
    expect(await prismaOwner.notification.count({ where: { tenantId } })).toBe(0);
    // Ein verworfener Auftrag ist kein Kandidat mehr.
    expect(await processMailOutbox(deps, { tenantId })).toMatchObject({ skipped: 0 });
  });

  it('verwirft eine Terminbestätigung, wenn der Termin inzwischen abgesagt wurde', async () => {
    // Review-Befund C1: Absagen statt Löschen. Der Termin bleibt mit CANCELLED
    // erhalten; die noch ausstehende Bestätigung geht nicht mehr hinaus.
    const slot = { startsAt: '2030-10-20T10:00', endsAt: '2030-10-20T11:00' };
    const requestId = (
      await prismaOwner.appointmentRequest.create({
        data: {
          tenantId,
          clientId,
          subject: 'Jahresgespräch',
          proposedSlots: [slot],
          status: 'ACCEPTED',
          acceptedSlot: slot,
          decidedByStaff: staffId,
          decidedAt: new Date(),
        },
      })
    ).id;
    const appointmentId = (
      await prismaOwner.appointment.create({
        data: {
          tenantId,
          ownerStaffId: staffId,
          createdByStaff: staffId,
          clientId,
          status: 'CONFIRMED',
          title: 'Jahresgespräch',
          startsAt: new Date('2030-10-20T08:00:00.000Z'),
          endsAt: new Date('2030-10-20T09:00:00.000Z'),
          fromRequestId: requestId,
        },
      })
    ).id;
    await prismaOwner.appointmentRequest.update({
      where: { id: requestId },
      data: { acceptedAppointmentId: appointmentId },
    });
    const id = await withWorkerTenantContext(tenantId, (tx) =>
      enqueueDirectMailTx(
        tx,
        {
          tenantId,
          clientId,
          purpose: 'appointment-confirmed',
          resource: { type: 'appointment_request', id: requestId },
          staffHref: '/staff/calendar',
        },
        {
          slug: 'appointment-confirmed',
          to: 'max@example.test',
          vars: { appointment: { title: 'Jahresgespräch' } },
          fallback: { subject: 'Termin-Bestätigung', bodyMd: '{{appointment.title}}' },
        },
      ),
    );
    await prismaOwner.appointment.update({
      where: { id: appointmentId },
      data: { status: 'CANCELLED' },
    });

    const stats = await processMailOutbox(deps, { tenantId });

    expect(stats).toMatchObject({ skipped: 1, processed: 0, escalated: 0 });
    expect(sendTemplateMail).not.toHaveBeenCalled();
    expect(await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'SKIPPED',
      payload: {},
      nextAttemptAt: null,
      lastError: 'Nicht versendet: Der Termin wurde abgesagt.',
    });
    // Der Termin selbst bleibt als abgesagt erhalten.
    expect(
      await prismaOwner.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    ).toMatchObject({ status: 'CANCELLED' });
  });

  it('entfernt erhaltenen Inhalt nach dem Neuversandfenster, frische Aufträge bleiben', async () => {
    const expired = await enqueue();
    const fresh = await enqueue();
    const escalated = new Date(Date.now() - (MAIL_OUTBOX_RESEND_WINDOW_DAYS + 1) * 86_400_000);
    for (const [id, escalatedAt] of [
      [expired, escalated],
      [fresh, new Date()],
    ] as const) {
      await prismaOwner.mailOutbox.update({
        where: { id },
        data: { status: 'FAILED', nextAttemptAt: null, escalatedAt },
      });
    }

    const stats = await processMailOutbox(deps, { tenantId });

    expect(stats.resendContentCleared).toBe(1);
    expect(
      await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id: expired } }),
    ).toMatchObject({ status: 'FAILED', payload: {}, secretVarsEnc: null });
    const kept = await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id: fresh } });
    expect(kept.payload).toMatchObject({ slug: 'handover-ready' });
    // Bereits geleerte Aufträge werden nicht erneut geschrieben.
    expect((await processMailOutbox(deps, { tenantId })).resendContentCleared).toBe(0);
  });

  it('entfernt erhaltenen Inhalt sofort, wenn der Mandant anonymisiert wurde', async () => {
    const anonymizedClient = (
      await prismaOwner.client.create({
        data: { tenantId, name: 'Synthetic anonymized client', kind: 'NATPERS' },
      })
    ).id;
    const id = await withWorkerTenantContext(tenantId, (tx) =>
      enqueueDirectMailTx(
        tx,
        {
          ...target(),
          clientId: anonymizedClient,
          staffHref: `/staff/clients/${anonymizedClient}`,
        },
        { slug: 'handover-ready', to: 'max@example.test', vars: {}, secretVars: { link: LINK } },
      ),
    );
    await prismaOwner.mailOutbox.update({
      where: { id },
      data: { status: 'UNKNOWN', nextAttemptAt: null, escalatedAt: new Date() },
    });
    await prismaOwner.client.update({
      where: { id: anonymizedClient },
      data: { anonymizedAt: new Date() },
    });

    expect((await processMailOutbox(deps, { tenantId })).resendContentCleared).toBe(1);
    expect(await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'UNKNOWN',
      payload: {},
      secretVarsEnc: null,
    });
  });
});
