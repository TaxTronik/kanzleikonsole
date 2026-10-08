import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// E2E gegen den Produktions-Standalone-Server: MailHog auf localhost:1025
// spricht kein STARTTLS. Mit requireTLS scheiterte jeder Magic-Link-Versand,
// und die Portal-Logins der Paranoid-Suite liefen ins Leere.
const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  env: {
    NODE_ENV: 'production',
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM: 'ci@example.test',
  },
}));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
vi.mock('../smtp-settings', () => ({ readSmtpConfigForSend: vi.fn() }));
vi.mock('@taxtronik/config', () => ({ env: mocks.env }));

import { isPlaintextMailhog } from '../send';

const ciE2e = { nodeEnv: 'production', ci: 'true', allowInProductionE2e: 'true' };

describe('isPlaintextMailhog', () => {
  it('lässt außerhalb von Produktion MailHog auf Port 1025 ohne STARTTLS zu', () => {
    const dev = { nodeEnv: 'development', ci: undefined, allowInProductionE2e: undefined };
    for (const host of ['localhost', '127.0.0.1', 'MailHog']) {
      expect(isPlaintextMailhog({ host, port: 1025 }, dev)).toBe(true);
    }
    expect(isPlaintextMailhog({ host: 'localhost', port: 587 }, dev)).toBe(false);
    expect(isPlaintextMailhog({ host: 'smtp.example.test', port: 1025 }, dev)).toBe(false);
  });

  it('verlangt in Produktion STARTTLS, solange der CI-E2E-Fall nicht vollständig gesetzt ist', () => {
    const cases = [
      { nodeEnv: 'production', ci: undefined, allowInProductionE2e: undefined },
      { nodeEnv: 'production', ci: 'true', allowInProductionE2e: undefined },
      { nodeEnv: 'production', ci: undefined, allowInProductionE2e: 'true' },
      { nodeEnv: 'production', ci: '1', allowInProductionE2e: 'true' },
    ];
    for (const runtime of cases) {
      expect(isPlaintextMailhog({ host: 'localhost', port: 1025 }, runtime)).toBe(false);
    }
  });

  it('erlaubt den CI-E2E-Fall in Produktion nur über Loopback auf Port 1025', () => {
    expect(isPlaintextMailhog({ host: 'localhost', port: 1025 }, ciE2e)).toBe(true);
    expect(isPlaintextMailhog({ host: '127.0.0.1', port: 1025 }, ciE2e)).toBe(true);
    expect(isPlaintextMailhog({ host: 'mailhog', port: 1025 }, ciE2e)).toBe(false);
    expect(isPlaintextMailhog({ host: 'smtp.example.test', port: 1025 }, ciE2e)).toBe(false);
    expect(isPlaintextMailhog({ host: 'localhost', port: 587 }, ciE2e)).toBe(false);
  });
});

describe('ENV-Transporter im Produktionsbuild', () => {
  const saved = {
    ci: process.env['CI'],
    flag: process.env['E2E_ALLOW_PLAINTEXT_SMTP_IN_PRODUCTION'],
  };

  beforeEach(() => {
    vi.resetModules();
    mocks.createTransport.mockReset();
    mocks.createTransport.mockImplementation(() => ({
      sendMail: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    }));
  });

  afterEach(() => {
    for (const [key, value] of [
      ['CI', saved.ci],
      ['E2E_ALLOW_PLAINTEXT_SMTP_IN_PRODUCTION', saved.flag],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function requireTlsFor(env: Record<string, string | undefined>): Promise<boolean> {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const { sendMail } = await import('../send');
    await sendMail({ to: 'mandant@example.test', subject: 'Login-Link', text: 'synthetisch' });
    return mocks.createTransport.mock.calls[0]![0].requireTLS;
  }

  it('liefert im CI-E2E-Lauf ohne STARTTLS an MailHog', async () => {
    expect(
      await requireTlsFor({ CI: 'true', E2E_ALLOW_PLAINTEXT_SMTP_IN_PRODUCTION: 'true' }),
    ).toBe(false);
  });

  it('erzwingt ohne die CI-Freigabe weiterhin STARTTLS', async () => {
    expect(
      await requireTlsFor({ CI: undefined, E2E_ALLOW_PLAINTEXT_SMTP_IN_PRODUCTION: undefined }),
    ).toBe(true);
  });
});
