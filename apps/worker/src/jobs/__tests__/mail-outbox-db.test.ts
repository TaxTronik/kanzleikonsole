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
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueDirectMailTx, type MailOutboxTarget } from '@taxtronik/mail/outbox';

const enabled = process.env['WORKER_DB_TEST'] === '1';
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
  processMailOutbox,
  type MailOutboxDeliveryDeps,
} from '../mail-outbox';

const describeDb = enabled ? describe : describe.skip;
const LINK = 'https://portal.example.test/gwg-onboarding?token=db-test-token';

describeDb('F-08 mail-outbox-deliver against PostgreSQL', () => {
  let tenantId = '';
  let clientId = '';
  const sendTemplateMail = vi.fn();
  const deps: MailOutboxDeliveryDeps = {
    db: prismaOwner,
    runAtomic: (tenant, fn) => withWorkerTenantContext(tenant, fn),
    sendTemplateMail,
    notifyClientContacts: vi.fn(),
    loadAttachment: vi.fn(),
    notifyStaff: (tx, input) => notify(tx, input),
    log: { warn: vi.fn(), error: vi.fn() },
  };

  function target(): MailOutboxTarget {
    return {
      tenantId,
      clientId,
      purpose: 'handover-ready',
      resource: { type: 'client_handover', id: randomUUID() },
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
  });

  afterAll(async () => {
    if (tenantId) await prismaOwner.tenant.delete({ where: { id: tenantId } });
    await prismaOwner.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await prismaOwner.mailOutbox.deleteMany({ where: { tenantId } });
    await prismaOwner.notification.deleteMany({ where: { tenantId } });
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
    expect(await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'FAILED',
      payload: {},
      secretVarsEnc: null,
      nextAttemptAt: null,
    });
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
    expect(await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'UNKNOWN',
      secretVarsEnc: null,
      payload: {},
    });
    expect(await prismaOwner.notification.count({ where: { tenantId } })).toBe(1);
  });
});
