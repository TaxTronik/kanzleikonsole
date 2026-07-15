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

vi.mock('@/server/mail/send', () => ({ sendMail: m.sendMail }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: m.emitN8nEvent }));
vi.mock('@/server/settings/mail-dispatch', () => ({ readMailDispatch: m.readMailDispatch }));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    emailTemplate: { findFirst: m.emailTemplateFindFirst },
    clientContact: { findMany: m.clientContactFindMany },
    client: { findFirst: m.clientFindFirst },
  },
}));
vi.mock('@/server/logger', () => ({ log: m.log }));

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
