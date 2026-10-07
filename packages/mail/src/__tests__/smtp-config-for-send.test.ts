// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001
//
// A7: Der Versandpfad liest die Tenant-SMTP-Konfiguration streng. Ein
// unbrauchbarer Eintrag (kein Objekt, falscher Feldtyp, ungültiger Port) und ein
// nicht entschlüsselbares Passwort werfen SmtpConfigInvalidError, bevor ein
// Transport entsteht. Die Einstellungsoberfläche (readSmtpConfig) bleibt
// nachsichtig. Echte Secret-Box, nur die Datenbank ist eine Attrappe.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret, SECRET_SLOTS, secretSlotContext } from '@taxtronik/crypto';

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), warn: vi.fn() }));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (
    _ctx: unknown,
    fn: (tx: { tenantSetting: { findUnique: typeof mocks.findUnique } }) => unknown,
  ) => fn({ tenantSetting: { findUnique: mocks.findUnique } }),
}));
vi.mock('../logger', () => ({ mailLog: () => ({ warn: mocks.warn, error: vi.fn() }) }));

import { readSmtpConfig, readSmtpConfigForSend, SmtpConfigInvalidError } from '../smtp-settings';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: TENANT, actorId: null, actorType: 'SYSTEM' as const };
const PASSWORD = 'synthetic-smtp-password';

function sealedFor(tenantId: string): string {
  return encryptSecret(PASSWORD, secretSlotContext(SECRET_SLOTS.smtpPassword, { tenantId }));
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    host: 'smtp.kanzlei.test',
    port: 587,
    secure: false,
    user: 'kanzlei@example.test',
    passwordEncrypted: sealedFor(TENANT),
    from: 'Kanzlei <kanzlei@example.test>',
    replyTo: '',
    ...overrides,
  };
}

function withStored(value: unknown) {
  mocks.findUnique.mockResolvedValue(value === undefined ? null : { value });
}

async function invalidReason(): Promise<string> {
  const error = await readSmtpConfigForSend(ctx).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SmtpConfigInvalidError);
  return (error as SmtpConfigInvalidError).reason;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('A7: readSmtpConfigForSend', () => {
  it('liefert null ohne gespeicherte Konfiguration (ENV-Fallback)', async () => {
    withStored(undefined);
    await expect(readSmtpConfigForSend(ctx)).resolves.toBeNull();
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: TENANT, key: 'mail.smtp' } },
      select: { value: true },
    });
  });

  it('entschlüsselt das Passwort einer vollständigen Konfiguration', async () => {
    withStored(stored());
    await expect(readSmtpConfigForSend(ctx)).resolves.toEqual({
      host: 'smtp.kanzlei.test',
      port: 587,
      secure: false,
      user: 'kanzlei@example.test',
      password: PASSWORD,
      from: 'Kanzlei <kanzlei@example.test>',
      replyTo: '',
    });
  });

  it('wirft für ein nicht entschlüsselbares Passwort statt leer weiterzusenden', async () => {
    // An einen anderen Tenant gebunden: die AAD passt nicht (wie Key-Rotation ohne Re-Wrap).
    withStored(stored({ passwordEncrypted: sealedFor(OTHER_TENANT) }));
    expect(await invalidReason()).toBe('password');
  });

  it('wirft für ein Passwortfeld ohne Secret-Format', async () => {
    withStored(stored({ passwordEncrypted: 'kein-secret' }));
    expect(await invalidReason()).toBe('password');
  });

  it.each([
    ['kein Objekt', 'mail.smtp'],
    ['eine Liste', [stored()]],
    ['JSON null', null],
    ['einen Host ohne Text', stored({ host: 42 })],
    ['einen Absender ohne Text', stored({ from: { name: 'Kanzlei' } })],
    ['einen Port außerhalb des Bereichs', stored({ port: 70_000 })],
    ['einen Port als Text', stored({ port: '587' })],
    ['eine Verschlüsselungsangabe ohne Wahrheitswert', stored({ secure: 'ja' })],
  ])('wirft für %s', async (_label, value) => {
    mocks.findUnique.mockResolvedValue({ value });
    expect(await invalidReason()).toBe('shape');
  });

  it('übernimmt den Legacy-Klartext ohne verschlüsseltes Feld', async () => {
    withStored(stored({ passwordEncrypted: '', password: 'legacy-synthetic' }));
    await expect(readSmtpConfigForSend(ctx)).resolves.toMatchObject({
      password: 'legacy-synthetic',
    });
  });

  it('entschlüsselt bei unvollständiger Konfiguration nicht (ENV-Fallback bleibt)', async () => {
    withStored(stored({ host: '', passwordEncrypted: sealedFor(OTHER_TENANT) }));
    await expect(readSmtpConfigForSend(ctx)).resolves.toMatchObject({ host: '', password: '' });
  });

  it('lässt die Einstellungsoberfläche bei unlesbarem Passwort nachsichtig', async () => {
    withStored(stored({ passwordEncrypted: sealedFor(OTHER_TENANT) }));
    await expect(readSmtpConfig(ctx)).resolves.toMatchObject({ password: '' });
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
