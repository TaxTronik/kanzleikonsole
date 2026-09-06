// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001, ACCESS-NOTIFICATION-RECIPIENT-001

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sendMail: vi.fn(),
  emitN8nEvent: vi.fn(),
  readMailDispatch: vi.fn(),
  emailTemplateFindFirst: vi.fn(),
  clientContactFindMany: vi.fn(),
  clientFindFirst: vi.fn(),
  log: { error: vi.fn() },
}));

vi.mock('../send', () => ({ sendMail: m.sendMail }));
vi.mock('../n8n-emitter', () => ({ emitViaConfiguredN8n: m.emitN8nEvent }));
vi.mock('../dispatch-settings', () => ({ readMailDispatch: m.readMailDispatch }));
vi.mock('@taxtronik/db', () => ({
  prismaOwner: {
    emailTemplate: { findFirst: m.emailTemplateFindFirst },
    clientContact: { findMany: m.clientContactFindMany },
    client: { findFirst: m.clientFindFirst },
  },
}));
vi.mock('../logger', () => ({ mailLog: () => m.log }));

import { notifyClientContacts, sendTemplateMail } from '../dispatch';

beforeEach(() => {
  vi.clearAllMocks();
  m.readMailDispatch.mockResolvedValue({ mode: 'APP' });
  m.emailTemplateFindFirst.mockResolvedValue({
    subject: 'Anforderung {{request.title}}',
    bodyMd: 'Hallo {{contact.fullName}}',
  });
  m.clientFindFirst.mockResolvedValue({ name: 'Hirschmann & Koxha GbR' });
  m.sendMail.mockResolvedValue({});
});

describe('Mandantenkontext im Mail-Betreff', () => {
  it('adressiert nur aktive, per Portal-Login bestätigte Empfänger', async () => {
    m.clientContactFindMany.mockResolvedValueOnce([]);

    await notifyClientContacts({
      tenantId: 'tenant-1',
      clientId: 'client-private',
      slug: 'request-opened',
      vars: {},
    });

    expect(m.clientContactFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        tenantId: 'tenant-1',
        clientId: 'client-private',
        active: true,
        notificationsEnabled: true,
        lastLoginAt: { not: null },
        client: { allowActive: true, anonymizedAt: null, mandateEndedAt: null },
      },
      select: { fullName: true, email: true },
    });
  });

  it('meldet erfolgreiche und versuchte Empfaenger getrennt', async () => {
    m.clientContactFindMany
      .mockResolvedValueOnce([
        { fullName: 'Rey Koxha', email: 'rey@example.test' },
        { fullName: 'Samira Koxha', email: 'samira@example.test' },
      ])
      .mockResolvedValueOnce([
        { email: 'rey@example.test', clientId: 'client-private' },
        { email: 'samira@example.test', clientId: 'client-private' },
      ]);
    m.sendMail.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('SMTP rejected'));

    await expect(
      notifyClientContacts({
        tenantId: 'tenant-1',
        clientId: 'client-private',
        slug: 'request-opened',
        vars: { request: { title: 'Belege' } },
      }),
    ).resolves.toEqual({
      ok: true,
      recipients: 1,
      attempted: 2,
      externalSideEffectOccurred: false,
      uncertainFailure: true,
    });
  });

  it('unterscheidet fehlende Empfaenger von einem erfolgreichen Versand', async () => {
    m.clientContactFindMany.mockResolvedValueOnce([]);

    await expect(
      notifyClientContacts({
        tenantId: 'tenant-1',
        clientId: 'client-private',
        slug: 'request-opened',
        vars: {},
      }),
    ).resolves.toEqual({
      ok: true,
      recipients: 0,
      attempted: 0,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });
  });

  it('emittiert das logische n8n-Ereignis auch ohne aktiven Mailkontakt genau einmal', async () => {
    m.readMailDispatch.mockResolvedValue({ mode: 'BOTH' });
    m.clientContactFindMany.mockResolvedValueOnce([]);

    await expect(
      notifyClientContacts({
        tenantId: 'tenant-1',
        clientId: 'client-private',
        slug: 'request-opened',
        vars: {},
        n8nEvent: 'request.opened',
        n8nPayload: { requestId: 'request-no-contact' },
      }),
    ).resolves.toEqual({
      ok: true,
      recipients: 0,
      attempted: 0,
      externalSideEffectOccurred: true,
      uncertainFailure: false,
    });
    expect(m.sendMail).not.toHaveBeenCalled();
    expect(m.emitN8nEvent).toHaveBeenCalledOnce();
    expect(m.emitN8nEvent).toHaveBeenCalledWith(
      'request.opened',
      { requestId: 'request-no-contact' },
      { tenantId: 'tenant-1' },
    );
  });

  it('emittiert ein vorgangsbezogenes n8n-Ereignis nur einmal und markiert den Side-Effect', async () => {
    m.readMailDispatch.mockResolvedValue({ mode: 'BOTH' });
    m.clientContactFindMany
      .mockResolvedValueOnce([
        { fullName: 'Rey Koxha', email: 'rey@example.test' },
        { fullName: 'Samira Koxha', email: 'samira@example.test' },
      ])
      .mockResolvedValueOnce([
        { email: 'rey@example.test', clientId: 'client-private' },
        { email: 'samira@example.test', clientId: 'client-private' },
      ]);
    m.sendMail.mockRejectedValue(new Error('SMTP rejected'));

    await expect(
      notifyClientContacts({
        tenantId: 'tenant-1',
        clientId: 'client-private',
        slug: 'request-opened',
        vars: { request: { title: 'Belege' } },
        n8nEvent: 'request.opened',
        n8nPayload: { requestId: 'request-1' },
      }),
    ).resolves.toEqual({
      ok: false,
      recipients: 0,
      attempted: 2,
      externalSideEffectOccurred: true,
      uncertainFailure: true,
    });

    expect(m.emitN8nEvent).toHaveBeenCalledOnce();
    expect(m.emitN8nEvent).toHaveBeenCalledWith(
      'request.opened',
      { requestId: 'request-1' },
      { tenantId: 'tenant-1' },
    );
  });

  it('wertet nur eine explizite SMTP-Ablehnung als eindeutig retrybar', async () => {
    m.clientContactFindMany
      .mockResolvedValueOnce([{ fullName: 'Rey Koxha', email: 'rey@example.test' }])
      .mockResolvedValueOnce([{ email: 'rey@example.test', clientId: 'client-private' }]);
    m.sendMail.mockRejectedValue(
      Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }),
    );

    await expect(
      notifyClientContacts({
        tenantId: 'tenant-1',
        clientId: 'client-private',
        slug: 'request-opened',
        vars: {},
      }),
    ).resolves.toEqual({
      ok: false,
      recipients: 0,
      attempted: 1,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });
  });

  it('kennzeichnet eine Anforderung, wenn dieselbe Adresse mehrere Mandantenprofile hat', async () => {
    m.clientContactFindMany
      .mockResolvedValueOnce([{ fullName: 'Rey Koxha', email: 'rey@example.test' }])
      .mockResolvedValueOnce([
        { email: 'rey@example.test', clientId: 'client-gbr' },
        { email: 'rey@example.test', clientId: 'client-private' },
      ]);

    await notifyClientContacts({
      tenantId: 'tenant-1',
      clientId: 'client-gbr',
      slug: 'request-opened',
      vars: { request: { title: 'Belege' } },
    });

    expect(m.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Anforderung Belege (Hirschmann & Koxha GbR)',
      }),
    );
  });

  it('lässt den Betreff bei einer eindeutigen Adresse unverändert', async () => {
    m.clientContactFindMany
      .mockResolvedValueOnce([{ fullName: 'Rey Koxha', email: 'rey@example.test' }])
      .mockResolvedValueOnce([{ email: 'rey@example.test', clientId: 'client-private' }]);
    m.clientFindFirst.mockResolvedValue({ name: 'Rey Koxha' });

    await notifyClientContacts({
      tenantId: 'tenant-1',
      clientId: 'client-private',
      slug: 'request-opened',
      vars: { request: { title: 'Belege' } },
    });

    expect(m.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Anforderung Belege' }),
    );
  });

  it('hängt einen bereits im Template vorhandenen Kontext nicht doppelt an', async () => {
    m.emailTemplateFindFirst.mockResolvedValue({
      subject: 'Login (Hirschmann & Koxha GbR)',
      bodyMd: 'Hallo',
    });

    await sendTemplateMail({
      tenantId: 'tenant-1',
      slug: 'magic-link',
      to: 'rey@example.test',
      vars: {},
      subjectSuffix: 'Hirschmann & Koxha GbR',
    });

    expect(m.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Login (Hirschmann & Koxha GbR)' }),
    );
  });

  it('ermittelt den Kontext auch für direkte mandantenbezogene Mail-Pfade zentral', async () => {
    m.clientContactFindMany.mockResolvedValue([
      { clientId: 'client-gbr' },
      { clientId: 'client-private' },
    ]);

    await sendTemplateMail({
      tenantId: 'tenant-1',
      clientId: 'client-gbr',
      slug: 'request-opened',
      to: 'rey@example.test',
      vars: { request: { title: 'Belege' }, contact: { fullName: 'Rey Koxha' } },
    });

    expect(m.clientContactFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        email: 'rey@example.test',
        active: true,
        client: { allowActive: true, anonymizedAt: null },
      },
      select: { clientId: true },
    });
    expect(m.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Anforderung Belege (Hirschmann & Koxha GbR)',
      }),
    );
  });
});
