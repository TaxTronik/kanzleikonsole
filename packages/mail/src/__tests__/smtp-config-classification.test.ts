// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001
//
// A7: Durchgehende Einordnung von sendTemplateMail über sendMail bis zur
// strengen SMTP-Konfiguration (echte Module, echte Secret-Box; nur Datenbank
// und nodemailer sind Attrappen). Eine nicht lesbare oder ungültige
// Konfiguration endet vor jedem SMTP-Kontakt und ist damit ein eindeutiger,
// wiederholbarer Fehlschlag. Ein Fehler nach Beginn der SMTP-Verbindung bleibt
// unklar (uncertainFailure → UNKNOWN beim Aufrufer).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret, SECRET_SLOTS, secretSlotContext } from '@taxtronik/crypto';

const m = vi.hoisted(() => ({
  settingFindUnique: vi.fn(),
  emailTemplateFindFirst: vi.fn(),
  clientContactFindMany: vi.fn(),
  clientFindFirst: vi.fn(),
  createTransport: vi.fn(),
  transportSend: vi.fn(),
}));

vi.mock('nodemailer', () => ({ default: { createTransport: m.createTransport } }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (
    _ctx: unknown,
    fn: (tx: { tenantSetting: { findUnique: typeof m.settingFindUnique } }) => unknown,
  ) => fn({ tenantSetting: { findUnique: m.settingFindUnique } }),
  prismaOwner: {
    emailTemplate: { findFirst: m.emailTemplateFindFirst },
    clientContact: { findMany: m.clientContactFindMany },
    client: { findFirst: m.clientFindFirst },
  },
}));
vi.mock('../dispatch-settings', () => ({ readMailDispatch: async () => ({ mode: 'APP' }) }));
vi.mock('../logger', () => ({ mailLog: () => ({ error: vi.fn(), warn: vi.fn() }) }));

import { notifyClientContacts, sendTemplateMail } from '../dispatch';
import { notifyAutomaticTaxRequestOpened } from '../request-opened';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';

function smtpSetting(passwordTenant: string, overrides: Record<string, unknown> = {}) {
  return {
    host: 'smtp.kanzlei.test',
    port: 587,
    secure: false,
    user: 'kanzlei@example.test',
    passwordEncrypted: encryptSecret(
      'synthetic-smtp-password',
      secretSlotContext(SECRET_SLOTS.smtpPassword, { tenantId: passwordTenant }),
    ),
    from: 'Kanzlei <kanzlei@example.test>',
    replyTo: '',
    ...overrides,
  };
}

const directMail = {
  tenantId: TENANT,
  slug: 'handover-ready',
  to: 'mandant@example.test',
  subjectSuffix: '',
  vars: { label: 'Belege 2025' },
  fallback: { subject: 'Abholbereit', bodyMd: '{{label}}' },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.emailTemplateFindFirst.mockResolvedValue(null);
  m.clientFindFirst.mockResolvedValue({ name: 'Mandant GmbH' });
  m.transportSend.mockResolvedValue({ accepted: ['mandant@example.test'] });
  m.createTransport.mockImplementation(() => ({ sendMail: m.transportSend, close: vi.fn() }));
});

describe('A7: Abbruch vor jedem SMTP-Kontakt ist ein eindeutiger Fehlschlag', () => {
  it.each([
    ['ein nicht entschlüsselbares Passwort', () => ({ value: smtpSetting(OTHER_TENANT) })],
    ['einen ungültigen Eintrag', () => ({ value: smtpSetting(TENANT, { port: 'smtp' }) })],
  ])('wertet %s nicht als unklar', async (_label, setting) => {
    m.settingFindUnique.mockResolvedValue(setting());

    await expect(sendTemplateMail(directMail)).resolves.toEqual({
      ok: false,
      sentViaTemplate: false,
      uncertainFailure: false,
      smtpConfigUnavailable: true,
    });
    expect(m.createTransport).not.toHaveBeenCalled();
  });

  it('wertet einen Datenbankfehler beim Lesen der Konfiguration nicht als unklar', async () => {
    m.settingFindUnique.mockRejectedValue(new Error('Connection terminated unexpectedly'));

    await expect(sendTemplateMail(directMail)).resolves.toMatchObject({
      ok: false,
      uncertainFailure: false,
      smtpConfigUnavailable: true,
    });
    expect(m.createTransport).not.toHaveBeenCalled();
  });

  it('fasst die Kontaktmail (Auto-Anforderung) als eindeutigen Totalfehler zusammen', async () => {
    m.settingFindUnique.mockResolvedValue({ value: smtpSetting(OTHER_TENANT) });
    m.clientContactFindMany
      .mockResolvedValueOnce([
        { fullName: 'Rey Koxha', email: 'rey@example.test' },
        { fullName: 'Samira Koxha', email: 'samira@example.test' },
      ])
      .mockResolvedValueOnce([
        { email: 'rey@example.test', clientId: CLIENT },
        { email: 'samira@example.test', clientId: CLIENT },
      ]);

    await expect(
      notifyAutomaticTaxRequestOpened({
        tenantId: TENANT,
        clientId: CLIENT,
        requestId: REQUEST,
        priority: 'NORMAL',
        dueAtIso: null,
      }),
    ).resolves.toEqual({
      ok: false,
      recipients: 0,
      attempted: 2,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
      smtpConfigUnavailable: true,
    });
    expect(m.createTransport).not.toHaveBeenCalled();
  });
});

describe('A7: Fehler nach Beginn der SMTP-Verbindung bleiben unklar', () => {
  const afterConnect = () =>
    Object.assign(new Error('Connection closed unexpectedly'), {
      code: 'ECONNECTION',
      command: 'DATA',
    });

  it('wertet einen Verbindungsabbruch ohne Provider-Antwort als unklar', async () => {
    m.settingFindUnique.mockResolvedValue({ value: smtpSetting(TENANT) });
    m.transportSend.mockRejectedValue(afterConnect());

    await expect(sendTemplateMail(directMail)).resolves.toEqual({
      ok: false,
      sentViaTemplate: false,
      uncertainFailure: true,
    });
    expect(m.createTransport).toHaveBeenCalledOnce();
  });

  it('meldet für Kontaktmails denselben unklaren Ausgang', async () => {
    m.settingFindUnique.mockResolvedValue({ value: smtpSetting(TENANT) });
    m.transportSend.mockRejectedValue(afterConnect());
    m.clientContactFindMany
      .mockResolvedValueOnce([{ fullName: 'Rey Koxha', email: 'rey@example.test' }])
      .mockResolvedValueOnce([{ email: 'rey@example.test', clientId: CLIENT }]);

    await expect(
      notifyClientContacts({
        tenantId: TENANT,
        clientId: CLIENT,
        slug: 'request-opened',
        vars: {},
        fallback: { subject: 'Neu', bodyMd: 'Bitte Portal öffnen' },
      }),
    ).resolves.toEqual({
      ok: false,
      recipients: 0,
      attempted: 1,
      externalSideEffectOccurred: false,
      uncertainFailure: true,
    });
  });
});
