import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readSmtpConfig: vi.fn(),
  createTransport: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
vi.mock('../smtp-settings', () => ({ readSmtpConfig: mocks.readSmtpConfig }));
vi.mock('../logger', () => ({ mailLog: () => ({ error: mocks.logError, warn: vi.fn() }) }));
vi.mock('@taxtronik/config', () => ({
  env: {
    NODE_ENV: 'test',
    SMTP_HOST: 'env-smtp.example.test',
    SMTP_PORT: 587,
    SMTP_USER: 'environment',
    SMTP_PASSWORD: 'synthetic',
    SMTP_FROM: 'environment@example.test',
  },
}));

const mail = {
  tenantId: 'tenant-1',
  to: 'recipient@example.test',
  subject: 'Synthetic test',
  text: 'No real delivery',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.createTransport.mockImplementation(() => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  }));
});

describe('F-05 sendMail tenant SMTP configuration errors', () => {
  it('fails the send instead of falling back to the .env SMTP server on a database error', async () => {
    const dbError = new Error('Connection terminated unexpectedly');
    mocks.readSmtpConfig.mockRejectedValue(dbError);
    const { sendMail, SmtpConfigUnavailableError } = await import('../send');

    const error = await sendMail(mail).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SmtpConfigUnavailableError);
    expect(error).toMatchObject({ retryable: true, tenantId: 'tenant-1', cause: dbError });
    // No SMTP contact at all: the mail was certainly not handed to any server.
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      {
        component: 'mail',
        tenantId: 'tenant-1',
        errName: 'Error',
        err: 'Connection terminated unexpectedly',
      },
      'mail: Tenant-SMTP-Konfiguration nicht lesbar — kein Fallback auf ENV-SMTP',
    );
  });

  it('keeps the documented .env fallback when the tenant has no SMTP configuration', async () => {
    mocks.readSmtpConfig.mockResolvedValue(null);
    const { sendMail } = await import('../send');

    await sendMail(mail);

    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(mocks.createTransport.mock.calls[0]![0]).toMatchObject({
      host: 'env-smtp.example.test',
    });
    const transport = mocks.createTransport.mock.results[0]!.value;
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'environment@example.test' }),
    );
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('keeps the .env fallback for an incomplete tenant configuration', async () => {
    mocks.readSmtpConfig.mockResolvedValue({
      host: '',
      port: 587,
      secure: false,
      user: '',
      password: '',
      from: '',
      replyTo: '',
    });
    const { sendMail } = await import('../send');

    await sendMail(mail);

    expect(mocks.createTransport.mock.calls[0]![0]).toMatchObject({
      host: 'env-smtp.example.test',
    });
  });

  it('does not read a tenant configuration for mails without tenant', async () => {
    const { sendMail } = await import('../send');
    await sendMail({ ...mail, tenantId: undefined });
    expect(mocks.readSmtpConfig).not.toHaveBeenCalled();
    expect(mocks.createTransport).toHaveBeenCalledOnce();
  });
});
