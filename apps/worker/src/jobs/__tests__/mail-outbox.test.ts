// =============================================================================
// F-08: Zustandsautomat der Mail-Outbox (Worker-Kern, ohne Infrastruktur).
//
// Die Aufträge entstehen über den echten Enqueue-Pfad von @taxtronik/mail
// (inkl. Secret-Box-Bindung des Einladungslinks); geprüft wird, dass der
// Worker daraus exakt die bisherigen Versandoptionen erzeugt, eindeutige
// Fehlschläge mit Backoff wiederholt, unklare und Teilzustellungen nie
// wiederholt und die Kanzlei bei jedem endgültigen Fehlschlag benachrichtigt.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  enqueueClientContactsMailTx,
  enqueueDirectMailTx,
  type MailOutboxTarget,
} from '@taxtronik/mail/outbox';
import {
  MAIL_OUTBOX_MAX_ATTEMPTS,
  processMailOutbox,
  type MailOutboxDeliveryDeps,
} from '../mail-outbox';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const INVITE = '33333333-3333-4333-8333-333333333333';
const HANDOVER = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const VERSION = '66666666-6666-4666-8666-666666666666';

type Row = Record<string, unknown> & { id: string; status: string; attemptCount: number };

async function enqueued(
  enqueue: (tx: {
    mailOutbox: { create: (args: { data: Row }) => Promise<unknown> };
  }) => Promise<string>,
  overrides: Partial<Row> = {},
): Promise<Row> {
  let data: Row | undefined;
  await enqueue({
    mailOutbox: {
      create: async (args) => {
        data = args.data;
        return args.data;
      },
    },
  });
  // Status und Versuchszähler setzt die Datenbank per Default.
  return { ...data!, status: 'QUEUED', attemptCount: 0, ...overrides };
}

const inviteTarget: MailOutboxTarget = {
  tenantId: TENANT,
  clientId: CLIENT,
  purpose: 'gwg-invite',
  resource: { type: 'gwg_onboarding_invite', id: INVITE },
  staffHref: `/staff/clients/${CLIENT}/gwg`,
};

function inviteRow(overrides: Partial<Row> = {}) {
  return enqueued(
    (tx) =>
      enqueueDirectMailTx(tx as unknown as Prisma.TransactionClient, inviteTarget, {
        slug: 'gwg-onboarding',
        to: 'max@example.test',
        vars: { inviteName: 'Max', inviteEmail: 'max@example.test', clientId: CLIENT },
        secretVars: { link: 'https://portal.example.test/gwg-onboarding?token=geheim' },
        fallback: { subject: 'Identifizierung', bodyMd: 'Bitte: {{link}}' },
      }),
    overrides,
  );
}

function handoverRow(overrides: Partial<Row> = {}) {
  return enqueued(
    (tx) =>
      enqueueDirectMailTx(
        tx as unknown as Prisma.TransactionClient,
        {
          tenantId: TENANT,
          clientId: CLIENT,
          purpose: 'handover-ready',
          resource: { type: 'client_handover', id: HANDOVER },
          staffHref: `/staff/clients/${CLIENT}`,
        },
        {
          slug: 'handover-ready',
          to: 'max@example.test',
          vars: { label: 'Belege 2025' },
          n8nEvent: 'client.handover.ready',
          n8nPayload: { tenantId: TENANT, handoverId: HANDOVER },
          fallback: { subject: 'Abholbereit', bodyMd: '{{label}}' },
          attachments: [
            { documentVersionId: VERSION, filename: 'R.pdf', contentType: 'application/pdf' },
          ],
        },
      ),
    overrides,
  );
}

function requestRow(overrides: Partial<Row> = {}) {
  return enqueued(
    (tx) =>
      enqueueClientContactsMailTx(
        tx as unknown as Prisma.TransactionClient,
        {
          tenantId: TENANT,
          clientId: CLIENT,
          purpose: 'request-opened',
          resource: { type: 'request', id: REQUEST },
          staffHref: `/staff/requests/${REQUEST}`,
        },
        {
          slug: 'request-opened',
          vars: { request: { id: REQUEST, title: 'Belege' }, portalUrl: 'https://p/x' },
          n8nEvent: 'request.opened',
          n8nPayload: { tenantId: TENANT, requestId: REQUEST },
          fallback: { subject: 'Neu', bodyMd: '{{request.title}}' },
        },
      ),
    overrides,
  );
}

function harness(rows: Row[], stranded: Row[] = []) {
  const findMany = vi
    .fn()
    .mockImplementation(async (args: { where: { status: unknown } }) =>
      args.where.status === 'SENDING' ? stranded : rows,
    );
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = { mailOutbox: { updateMany } };
  const sendTemplateMail = vi
    .fn()
    .mockResolvedValue({ ok: true, sentViaTemplate: false, uncertainFailure: false });
  const notifyClientContacts = vi.fn().mockResolvedValue({
    ok: true,
    recipients: 2,
    attempted: 2,
    externalSideEffectOccurred: false,
    uncertainFailure: false,
  });
  const loadAttachment = vi.fn().mockResolvedValue({
    filename: 'R.pdf',
    content: Buffer.from('%PDF-1.7'),
    contentType: 'application/pdf',
  });
  const notifyStaff = vi.fn().mockResolvedValue(undefined);
  const log = { warn: vi.fn(), error: vi.fn() };
  const deps = {
    db: { mailOutbox: { findMany } },
    runAtomic: vi.fn(async (_tenantId: string, fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
    sendTemplateMail,
    notifyClientContacts,
    loadAttachment,
    notifyStaff,
    log,
  } as unknown as MailOutboxDeliveryDeps;
  return {
    deps,
    findMany,
    updateMany,
    sendTemplateMail,
    notifyClientContacts,
    loadAttachment,
    notifyStaff,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Mail-Outbox: Versand mit unveränderten Optionen', () => {
  it('legt den Einladungslink nur verschlüsselt ab und setzt ihn erst beim Versand ein', async () => {
    const row = await inviteRow();
    expect(JSON.stringify(row.payload)).not.toContain('geheim');
    expect(row.secretVarsEnc).toEqual(expect.any(String));
    expect(String(row.secretVarsEnc)).not.toContain('geheim');

    const h = harness([row]);
    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.findMany.mock.calls[1]![0].where).toEqual({
      status: { in: ['QUEUED', 'RETRY_PENDING'] },
      nextAttemptAt: { lte: NOW },
    });
    // Claim vor dem externen I/O, gebunden an Status und Versuchszähler.
    expect(h.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: row.id, status: 'QUEUED', attemptCount: 0 },
      data: expect.objectContaining({
        status: 'SENDING',
        attemptCount: { increment: 1 },
        lastAttemptAt: NOW,
        nextAttemptAt: null,
      }),
    });
    expect(h.sendTemplateMail).toHaveBeenCalledWith({
      tenantId: TENANT,
      clientId: CLIENT,
      slug: 'gwg-onboarding',
      to: 'max@example.test',
      vars: {
        inviteName: 'Max',
        inviteEmail: 'max@example.test',
        clientId: CLIENT,
        link: 'https://portal.example.test/gwg-onboarding?token=geheim',
      },
      fallback: { subject: 'Identifizierung', bodyMd: 'Bitte: {{link}}' },
    });
    // Terminal: Inhalt und Secret verlassen den Auftrag.
    expect(h.updateMany.mock.calls[1]![0]).toEqual({
      where: { id: row.id, status: 'SENDING', attemptCount: 1, lastAttemptAt: NOW },
      data: expect.objectContaining({
        status: 'PROVIDER_ACCEPTED',
        acceptedAt: NOW,
        payload: {},
        secretVarsEnc: null,
        nextAttemptAt: null,
        recipientsAttempted: 1,
        recipientsAccepted: 1,
        escalatedAt: null,
      }),
    });
    expect(h.notifyStaff).not.toHaveBeenCalled();
    expect(stats).toEqual({
      processed: 1,
      providerAccepted: 1,
      retryPending: 0,
      noRecipient: 0,
      escalated: 0,
    });
  });

  it('lädt Anhänge aus der gebundenen Fassung und gibt n8n einen Dedupe-Schlüssel je Auftrag', async () => {
    const row = await handoverRow();
    const h = harness([row]);

    await processMailOutbox(h.deps, { now: NOW });

    expect(h.loadAttachment).toHaveBeenCalledWith({
      tenantId: TENANT,
      ref: { documentVersionId: VERSION, filename: 'R.pdf', contentType: 'application/pdf' },
    });
    expect(h.sendTemplateMail).toHaveBeenCalledWith(
      expect.objectContaining({
        n8nEvent: 'client.handover.ready',
        n8nPayload: { tenantId: TENANT, handoverId: HANDOVER },
        n8nDedupeKey: `mail-outbox:${row.id}`,
        attachments: [
          { filename: 'R.pdf', content: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' },
        ],
      }),
    );
  });

  it('löst Kontakte erst beim Versand über notifyClientContacts auf', async () => {
    const row = await requestRow();
    const h = harness([row]);

    await processMailOutbox(h.deps, { now: NOW });

    expect(h.notifyClientContacts).toHaveBeenCalledWith({
      tenantId: TENANT,
      clientId: CLIENT,
      slug: 'request-opened',
      vars: { request: { id: REQUEST, title: 'Belege' }, portalUrl: 'https://p/x' },
      fallback: { subject: 'Neu', bodyMd: '{{request.title}}' },
      n8nEvent: 'request.opened',
      n8nPayload: { tenantId: TENANT, requestId: REQUEST },
      n8nDedupeKey: `mail-outbox:${row.id}`,
    });
    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      status: 'PROVIDER_ACCEPTED',
      recipientsAttempted: 2,
      recipientsAccepted: 2,
    });
  });

  it('versendet nichts, wenn ein paralleler Lauf den Auftrag bereits beansprucht hat', async () => {
    const h = harness([await inviteRow()]);
    h.updateMany.mockResolvedValueOnce({ count: 0 });

    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.sendTemplateMail).not.toHaveBeenCalled();
    expect(stats.processed).toBe(0);
  });
});

describe('Mail-Outbox: Retry, Terminalstatus und Kanzlei-Hinweis', () => {
  it('wiederholt eine ausdrückliche Provider-Ablehnung mit exponentiellem Backoff', async () => {
    const row = await inviteRow({ status: 'RETRY_PENDING', attemptCount: 2 });
    const h = harness([row]);
    h.sendTemplateMail.mockResolvedValue({
      ok: false,
      sentViaTemplate: true,
      uncertainFailure: false,
    });

    const stats = await processMailOutbox(h.deps, { now: NOW });

    const retry = h.updateMany.mock.calls[1]![0];
    expect(retry.where).toEqual({
      id: row.id,
      status: 'SENDING',
      attemptCount: 3,
      lastAttemptAt: NOW,
    });
    expect(retry.data).toMatchObject({
      status: 'RETRY_PENDING',
      // dritter Versuch gescheitert → 4 Minuten (1, 2, 4, 8, 16 min)
      nextAttemptAt: new Date('2026-10-06T10:04:00.000Z'),
      recipientsAttempted: 1,
      recipientsAccepted: 0,
    });
    // Payload und Secret bleiben für den nächsten Versuch erhalten.
    expect(retry.data).not.toHaveProperty('payload');
    expect(retry.data).not.toHaveProperty('secretVarsEnc');
    expect(h.notifyStaff).not.toHaveBeenCalled();
    expect(stats.retryPending).toBe(1);
  });

  it('beendet nach dem letzten Versuch mit FAILED und benachrichtigt die Kanzlei am Mandanten', async () => {
    const row = await handoverRow({
      status: 'RETRY_PENDING',
      attemptCount: MAIL_OUTBOX_MAX_ATTEMPTS - 1,
    });
    const h = harness([row]);
    h.sendTemplateMail.mockResolvedValue({
      ok: false,
      sentViaTemplate: false,
      uncertainFailure: false,
    });

    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      status: 'FAILED',
      payload: {},
      secretVarsEnc: null,
      nextAttemptAt: null,
      escalatedAt: NOW,
    });
    // client_handover kennt der Benachrichtigungs-Scope nicht → Mandant.
    expect(h.notifyStaff).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      clientId: CLIENT,
      staffId: null,
      kind: 'SYSTEM_MAIL_FAILED',
      title: 'E-Mail an Mandanten fehlgeschlagen',
      body: expect.stringContaining(
        'Abholbenachrichtigung: Nach 6 eindeutig gescheiterten Versuchen',
      ),
      href: `/staff/clients/${CLIENT}`,
      resourceType: 'client',
      resourceId: CLIENT,
    });
    expect(stats.escalated).toBe(1);
  });

  it('wiederholt einen unklaren SMTP-Ausgang nie, sondern eskaliert am Vorgang', async () => {
    const row = await inviteRow();
    const h = harness([row]);
    h.sendTemplateMail.mockResolvedValue({
      ok: false,
      sentViaTemplate: true,
      uncertainFailure: true,
    });

    await processMailOutbox(h.deps, { now: NOW });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      status: 'UNKNOWN',
      payload: {},
      secretVarsEnc: null,
      nextAttemptAt: null,
    });
    expect(h.notifyStaff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Versandstatus einer Mandanten-E-Mail unklar',
        resourceType: 'gwg_onboarding_invite',
        resourceId: INVITE,
        href: `/staff/clients/${CLIENT}/gwg`,
      }),
    );
  });

  it('behandelt eine Exception des Versands als unklaren Ausgang', async () => {
    const h = harness([await requestRow()]);
    h.notifyClientContacts.mockRejectedValue(new Error('socket hang up'));

    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({ status: 'UNKNOWN' });
    expect(stats.escalated).toBe(1);
  });

  it('meldet Teilzustellung ohne Neuversand und zählt die Empfänger', async () => {
    const h = harness([await requestRow()]);
    h.notifyClientContacts.mockResolvedValue({
      ok: true,
      recipients: 1,
      attempted: 3,
      externalSideEffectOccurred: true,
      uncertainFailure: false,
    });

    await processMailOutbox(h.deps, { now: NOW });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      status: 'PARTIAL_FAILURE',
      recipientsAttempted: 3,
      recipientsAccepted: 1,
    });
    expect(h.notifyStaff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Mandanten-E-Mail nur teilweise zugestellt',
        resourceType: 'request',
        resourceId: REQUEST,
      }),
    );
  });

  it('wiederholt einen eindeutigen Totalausfall aller Kontakte', async () => {
    const h = harness([await requestRow()]);
    h.notifyClientContacts.mockResolvedValue({
      ok: false,
      recipients: 0,
      attempted: 2,
      externalSideEffectOccurred: true,
      uncertainFailure: false,
    });

    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      status: 'RETRY_PENDING',
      nextAttemptAt: new Date('2026-10-06T10:01:00.000Z'),
      recipientsAttempted: 2,
      recipientsAccepted: 0,
    });
    expect(stats.retryPending).toBe(1);
  });

  it('bleibt ohne bestätigten Kontakt still (NO_RECIPIENT, kein Hinweis)', async () => {
    const h = harness([await requestRow()]);
    h.notifyClientContacts.mockResolvedValue({
      ok: true,
      recipients: 0,
      attempted: 0,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });

    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      status: 'NO_RECIPIENT',
      recipientsAttempted: 0,
      payload: {},
    });
    expect(h.notifyStaff).not.toHaveBeenCalled();
    expect(stats.noRecipient).toBe(1);
  });

  it('wiederholt ein nicht ladbares Attachment ohne SMTP-Kontakt', async () => {
    const h = harness([await handoverRow()]);
    h.loadAttachment.mockRejectedValue(new Error('HASH_MISMATCH'));

    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.sendTemplateMail).not.toHaveBeenCalled();
    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({ status: 'RETRY_PENDING' });
    expect(stats.retryPending).toBe(1);
  });

  describe('A7: nicht lesbare SMTP-Konfiguration (vor jedem SMTP-Kontakt)', () => {
    const configFailure = {
      ok: false,
      sentViaTemplate: true,
      uncertainFailure: false,
      smtpConfigUnavailable: true,
    };

    it('wiederholt eine Einzelmail mit Backoff statt UNKNOWN', async () => {
      const row = await inviteRow();
      const h = harness([row]);
      h.sendTemplateMail.mockResolvedValue(configFailure);

      const stats = await processMailOutbox(h.deps, { now: NOW });

      const retry = h.updateMany.mock.calls[1]![0];
      expect(retry.data).toMatchObject({
        status: 'RETRY_PENDING',
        nextAttemptAt: new Date('2026-10-06T10:01:00.000Z'),
        lastError:
          'Die SMTP-Konfiguration der Kanzlei war nicht lesbar oder ungültig; der Versand wurde vor jedem SMTP-Kontakt abgebrochen. Versuch 1 von 6; erneuter Versuch geplant.',
      });
      // Inhalt und Secret bleiben für den nächsten Versuch erhalten.
      expect(retry.data).not.toHaveProperty('payload');
      expect(h.notifyStaff).not.toHaveBeenCalled();
      expect(stats.retryPending).toBe(1);
    });

    it('wiederholt eine Kontaktmail ohne übergebenen Empfänger', async () => {
      const h = harness([await requestRow()]);
      h.notifyClientContacts.mockResolvedValue({
        ok: false,
        recipients: 0,
        attempted: 2,
        externalSideEffectOccurred: false,
        uncertainFailure: false,
        smtpConfigUnavailable: true,
      });

      const stats = await processMailOutbox(h.deps, { now: NOW });

      expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
        status: 'RETRY_PENDING',
        recipientsAttempted: 2,
        recipientsAccepted: 0,
        lastError: expect.stringContaining(
          'Keiner von 2 Mail-Einzelversuchen wurde an den Mail-Provider übergeben.',
        ),
      });
      expect(stats.retryPending).toBe(1);
    });

    it('beendet nach dem letzten Versuch mit FAILED und Hinweis auf die SMTP-Einstellungen', async () => {
      const h = harness([
        await handoverRow({ status: 'RETRY_PENDING', attemptCount: MAIL_OUTBOX_MAX_ATTEMPTS - 1 }),
      ]);
      h.sendTemplateMail.mockResolvedValue(configFailure);

      const stats = await processMailOutbox(h.deps, { now: NOW });

      expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({ status: 'FAILED' });
      expect(h.notifyStaff).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          title: 'E-Mail an Mandanten fehlgeschlagen',
          body: expect.stringContaining('Bitte die SMTP-Einstellungen der Kanzlei prüfen.'),
        }),
      );
      expect(stats.escalated).toBe(1);
    });

    it('bleibt bei einem Fehler nach Beginn der SMTP-Verbindung UNKNOWN', async () => {
      const h = harness([await inviteRow()]);
      // Verbindungsabbruch ohne Provider-Antwort: sendTemplateMail meldet unklar.
      h.sendTemplateMail.mockResolvedValue({
        ok: false,
        sentViaTemplate: true,
        uncertainFailure: true,
      });

      const stats = await processMailOutbox(h.deps, { now: NOW });

      expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({ status: 'UNKNOWN' });
      expect(stats.retryPending).toBe(0);
      expect(stats.escalated).toBe(1);
    });
  });

  it('eskaliert einen hängenden Versandversuch nach 30 Minuten ohne Neuversand', async () => {
    const lastAttemptAt = new Date('2026-10-06T09:20:00.000Z');
    const stuck = {
      ...(await inviteRow({ status: 'SENDING', attemptCount: 1 })),
      lastAttemptAt,
    };
    const h = harness([], [stuck]);

    const stats = await processMailOutbox(h.deps, { now: NOW });

    expect(h.findMany.mock.calls[0]![0].where).toEqual({
      status: 'SENDING',
      lastAttemptAt: { lte: new Date('2026-10-06T09:30:00.000Z') },
    });
    expect(h.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: stuck.id, status: 'SENDING', lastAttemptAt },
      data: expect.objectContaining({
        status: 'UNKNOWN',
        escalatedAt: NOW,
        payload: {},
        secretVarsEnc: null,
      }),
    });
    expect(h.notifyStaff).toHaveBeenCalledTimes(1);
    expect(h.sendTemplateMail).not.toHaveBeenCalled();
    expect(stats.escalated).toBe(1);
  });
});
