// K-10: Der n8n-Emitter des Mail-Pakets wird explizit genau einmal je Prozess
// registriert. Fehlt die Registrierung, fällt kein Ereignis mehr mit einer
// bloßen Warnung weg: emitViaConfiguredN8n wirft, und sendTemplateMail bricht
// im Dispatch-Modus BOTH vor jedem SMTP-Kontakt ab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sendMail: vi.fn(),
  readMailDispatch: vi.fn(),
  emailTemplateFindFirst: vi.fn(),
  clientContactFindMany: vi.fn(),
}));

vi.mock('../send', () => ({ sendMail: m.sendMail }));
vi.mock('../dispatch-settings', () => ({ readMailDispatch: m.readMailDispatch }));
vi.mock('@taxtronik/db', () => {
  const client = { findFirst: vi.fn().mockResolvedValue({ name: 'Mandant' }) };
  return {
    withSystemContext: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        emailTemplate: { findFirst: m.emailTemplateFindFirst },
        clientContact: { findMany: m.clientContactFindMany },
        client,
      }),
  };
});
vi.mock('../logger', () => ({ mailLog: () => ({ error: vi.fn(), warn: vi.fn() }) }));

import {
  emitViaConfiguredN8n,
  hasN8nEmitter,
  MailN8nEmitterMissingError,
  resetN8nEmitterForTests,
  setN8nEmitter,
} from '../n8n-emitter';
import { notifyClientContacts, sendTemplateMail } from '../dispatch';

const fallback = { subject: 'Betreff', bodyMd: 'Text' };

beforeEach(() => {
  vi.clearAllMocks();
  resetN8nEmitterForTests();
  m.readMailDispatch.mockResolvedValue({ mode: 'BOTH' });
  m.emailTemplateFindFirst.mockResolvedValue(null);
  m.sendMail.mockResolvedValue({});
});

afterEach(() => {
  resetN8nEmitterForTests();
});

describe('Registrierung des n8n-Emitters', () => {
  it('lässt ohne Registrierung kein Ereignis still wegfallen', async () => {
    expect(hasN8nEmitter()).toBe(false);
    await expect(
      emitViaConfiguredN8n('request.opened', {}, { tenantId: 'tenant-1' }),
    ).rejects.toBeInstanceOf(MailN8nEmitterMissingError);
  });

  it('bricht eine BOTH-Mail ohne Registrierung vor dem SMTP-Versand ab', async () => {
    await expect(
      sendTemplateMail({
        tenantId: 'tenant-1',
        slug: 'handover-ready',
        to: 'a@example.test',
        vars: {},
        fallback,
        n8nEvent: 'client.handover.ready',
      }),
    ).rejects.toBeInstanceOf(MailN8nEmitterMissingError);
    m.clientContactFindMany.mockResolvedValueOnce([{ fullName: 'A', email: 'a@example.test' }]);
    await expect(
      notifyClientContacts({
        tenantId: 'tenant-1',
        clientId: 'client-1',
        slug: 'request-opened',
        vars: {},
        fallback,
        n8nEvent: 'request.opened',
      }),
    ).rejects.toBeInstanceOf(MailN8nEmitterMissingError);

    expect(m.sendMail).not.toHaveBeenCalled();
  });

  it('versendet ohne n8n-Ereignis oder im Modus APP auch ohne Registrierung', async () => {
    m.readMailDispatch.mockResolvedValue({ mode: 'APP' });
    await expect(
      sendTemplateMail({
        tenantId: 'tenant-1',
        slug: 'handover-ready',
        to: 'a@example.test',
        vars: {},
        fallback,
        n8nEvent: 'client.handover.ready',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(m.sendMail).toHaveBeenCalledOnce();
  });

  it('registriert genau einen Emitter je Prozess', async () => {
    const emitter = vi.fn().mockResolvedValue(undefined);
    setN8nEmitter(emitter);
    setN8nEmitter(emitter);

    expect(() => setN8nEmitter(vi.fn())).toThrow(/bereits registriert/);
    await emitViaConfiguredN8n('request.opened', { id: 1 }, { tenantId: 'tenant-1' });
    expect(emitter).toHaveBeenCalledOnce();
    expect(emitter).toHaveBeenCalledWith('request.opened', { id: 1 }, { tenantId: 'tenant-1' });
  });

  it('versendet mit Registrierung und emittiert das Ereignis nach dem SMTP-Versand', async () => {
    const emitter = vi.fn().mockResolvedValue(undefined);
    setN8nEmitter(emitter);

    await expect(
      sendTemplateMail({
        tenantId: 'tenant-1',
        slug: 'handover-ready',
        to: 'a@example.test',
        vars: {},
        fallback,
        n8nEvent: 'client.handover.ready',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(m.sendMail.mock.invocationCallOrder[0]).toBeLessThan(
      emitter.mock.invocationCallOrder[0]!,
    );
  });
});
