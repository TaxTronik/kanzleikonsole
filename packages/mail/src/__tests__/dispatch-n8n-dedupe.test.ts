// F-08: Der Mail-Outbox-Worker gibt jedem Versandauftrag einen n8n-Dedupe-
// Schlüssel. Ein erneuter Versuch nach eindeutigem SMTP-Fehlschlag darf das
// vorgangsbezogene n8n-Ereignis damit nicht ein zweites Mal auslösen; ohne
// Schlüssel (synchrone Pfade) bleibt der Aufruf unverändert.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sendMail: vi.fn(),
  emit: vi.fn(),
  readMailDispatch: vi.fn(),
  emailTemplateFindFirst: vi.fn(),
  clientContactFindMany: vi.fn(),
  clientFindFirst: vi.fn(),
}));

vi.mock('../send', () => ({ sendMail: m.sendMail }));
vi.mock('../n8n-emitter', () => ({
  emitViaConfiguredN8n: m.emit,
  assertN8nEmitterRegistered: vi.fn(),
}));
vi.mock('../dispatch-settings', () => ({ readMailDispatch: m.readMailDispatch }));
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      emailTemplate: { findFirst: m.emailTemplateFindFirst },
      clientContact: { findMany: m.clientContactFindMany },
      client: { findFirst: m.clientFindFirst },
    }),
}));
vi.mock('../logger', () => ({ mailLog: () => ({ error: vi.fn(), warn: vi.fn() }) }));

import { notifyClientContacts, sendTemplateMail } from '../dispatch';

beforeEach(() => {
  vi.clearAllMocks();
  m.readMailDispatch.mockResolvedValue({ mode: 'BOTH' });
  m.emailTemplateFindFirst.mockResolvedValue(null);
  m.clientFindFirst.mockResolvedValue({ name: 'Mandant' });
  m.sendMail.mockResolvedValue({});
});

const fallback = { subject: 'Betreff', bodyMd: 'Text' };

describe('n8n-Dedupe-Schlüssel der Mail-Outbox', () => {
  it('reicht den Schlüssel einer Einzelmail an das n8n-Ereignis weiter', async () => {
    m.clientContactFindMany.mockResolvedValue([]);
    await sendTemplateMail({
      tenantId: 'tenant-1',
      slug: 'handover-ready',
      to: 'a@example.test',
      vars: {},
      fallback,
      n8nEvent: 'client.handover.ready',
      n8nPayload: { handoverId: 'h-1' },
      n8nDedupeKey: 'mail-outbox:o-1',
    });

    expect(m.emit).toHaveBeenCalledWith(
      'client.handover.ready',
      { handoverId: 'h-1' },
      { tenantId: 'tenant-1', dedupeKey: 'mail-outbox:o-1' },
    );
  });

  it('auch nach SMTP-Fehlschlag mit demselben Schlüssel', async () => {
    m.sendMail.mockRejectedValue(Object.assign(new Error('rejected'), { responseCode: 550 }));
    const result = await sendTemplateMail({
      tenantId: 'tenant-1',
      slug: 'handover-ready',
      to: 'a@example.test',
      vars: {},
      fallback,
      n8nEvent: 'client.handover.ready',
      n8nDedupeKey: 'mail-outbox:o-1',
    });

    expect(result).toEqual({ ok: false, sentViaTemplate: false, uncertainFailure: false });
    expect(m.emit).toHaveBeenCalledWith(
      'client.handover.ready',
      {},
      {
        tenantId: 'tenant-1',
        dedupeKey: 'mail-outbox:o-1',
      },
    );
  });

  it('emittiert das Kontakt-Ereignis einmal mit Schlüssel, nie je Kontakt', async () => {
    m.clientContactFindMany
      .mockResolvedValueOnce([
        { fullName: 'A', email: 'a@example.test' },
        { fullName: 'B', email: 'b@example.test' },
      ])
      .mockResolvedValueOnce([]);

    await notifyClientContacts({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      slug: 'request-opened',
      vars: {},
      fallback,
      n8nEvent: 'request.opened',
      n8nPayload: { requestId: 'r-1' },
      n8nDedupeKey: 'mail-outbox:o-2',
    });

    expect(m.sendMail).toHaveBeenCalledTimes(2);
    expect(m.emit).toHaveBeenCalledTimes(1);
    expect(m.emit).toHaveBeenCalledWith(
      'request.opened',
      { requestId: 'r-1' },
      { tenantId: 'tenant-1', dedupeKey: 'mail-outbox:o-2' },
    );
  });

  it('ruft synchrone Pfade ohne Schlüssel unverändert auf', async () => {
    await sendTemplateMail({
      tenantId: 'tenant-1',
      slug: 'magic-link',
      to: 'a@example.test',
      vars: {},
      fallback,
      n8nEvent: 'client.handover.ready',
    });

    expect(m.emit).toHaveBeenCalledWith('client.handover.ready', {}, { tenantId: 'tenant-1' });
  });
});
