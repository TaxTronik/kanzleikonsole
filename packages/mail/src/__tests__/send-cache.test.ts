import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readSmtpConfig: vi.fn(), createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
vi.mock('../smtp-settings', () => ({ readSmtpConfig: mocks.readSmtpConfig }));
vi.mock('@taxtronik/config', () => ({
  env: {
    NODE_ENV: 'test',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: 587,
    SMTP_USER: 'environment',
    SMTP_PASSWORD: 'synthetic',
    SMTP_FROM: 'environment@example.test',
  },
}));

const config = {
  host: 'tenant.smtp.test',
  port: 587,
  secure: false,
  user: 'tenant@example.test',
  password: 'old-synthetic-password',
  from: 'tenant@example.test',
  replyTo: '',
};
const mail = {
  tenantId: 'tenant-1',
  to: 'recipient@example.test',
  subject: 'Synthetic test',
  text: 'No real delivery',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.readSmtpConfig.mockResolvedValue({ ...config });
  mocks.createTransport.mockImplementation(() => ({
    sendMail: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  }));
});

describe('tenant SMTP transporter cache', () => {
  it('uses a rotated password even when its length stays unchanged', async () => {
    const { sendMail } = await import('../send');
    await sendMail(mail);
    const oldTransport = mocks.createTransport.mock.results[0]!.value;
    mocks.readSmtpConfig.mockResolvedValue({ ...config, password: 'new-synthetic-password' });
    await sendMail(mail);

    expect(mocks.createTransport).toHaveBeenCalledTimes(2);
    expect(mocks.createTransport.mock.calls[1]![0].auth.pass).toBe('new-synthetic-password');
    expect(oldTransport.close).toHaveBeenCalledOnce();
    expect(oldTransport.sendMail).toHaveBeenCalledOnce();
    expect(mocks.createTransport.mock.results[1]!.value.sendMail).toHaveBeenCalledOnce();
  });

  it('reuses unchanged transport settings while applying a changed reply-to per message', async () => {
    const { sendMail } = await import('../send');
    await sendMail(mail);
    mocks.readSmtpConfig.mockResolvedValue({ ...config, replyTo: 'new-reply@example.test' });
    await sendMail(mail);

    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(mocks.createTransport.mock.results[0]!.value.sendMail.mock.calls[1]![0].replyTo).toBe(
      'new-reply@example.test',
    );
  });

  it('keeps equal SMTP configurations isolated by tenant', async () => {
    const { sendMail } = await import('../send');
    await sendMail(mail);
    await sendMail({ ...mail, tenantId: 'tenant-2' });
    expect(mocks.createTransport).toHaveBeenCalledTimes(2);
  });
});
