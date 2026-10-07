// =============================================================================
// Mandanten-spezifische SMTP-Konfiguration
//
// Liegt in `tenant_setting` unter dem Key `mail.smtp`. Passwort wird mit
// `encryptSecret` (AES-256-GCM) verschlüsselt im JSONB abgelegt — nie als
// Klartext. Beim Lesen werden Passwort/User auf Wunsch entschlüsselt (in der
// UI-Schicht maskieren).
//
// Wenn keine DB-Konfiguration existiert, fällt der Mail-Sender auf die ENV-
// Werte zurück (SMTP_HOST/PORT/USER/PASSWORD/FROM). Damit funktionieren
// Onboarding und Smoke-Tests ohne UI-Konfiguration, und Bestandsinstallationen
// brauchen keine Migration.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import {
  deleteTenantSettingValue,
  readTenantSettingValue,
  writeTenantSettingValue,
  type TenantSettingReader,
} from '@taxtronik/db/tenant-settings';
import { env } from '@taxtronik/config';
import {
  decryptSecret,
  encryptSecret,
  looksEncrypted,
  readEncryptedSetting,
  SECRET_SLOTS,
  secretSlotContext,
} from '@taxtronik/crypto';
import { mailLog } from './logger';

const KEY = 'mail.smtp';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // True für Port 465 (TLS), sonst STARTTLS opportunistisch
  user: string; // Login (oft = From-Adresse)
  password: string; // Klartext (im DB-Roundtrip verschlüsselt)
  from: string; // "Kanzlei Mustermann <kanzlei@example.de>"
  replyTo: string; // Optional
}

export const DEFAULT_SMTP_CONFIG: SmtpConfig = {
  host: '',
  port: 587,
  secure: false,
  user: '',
  password: '',
  from: '',
  replyTo: '',
};

/** Persistenz-Form: Passwort verschlüsselt. */
interface SmtpStored {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordEncrypted: string;
  from: string;
  replyTo: string;
}

/** S-08: Das Passwort ist per AAD an Tenant, Setting und Feld gebunden. */
function passwordContext(tenantId: string) {
  return secretSlotContext(SECRET_SLOTS.smtpPassword, { tenantId });
}

export interface SmtpStatus {
  configured: boolean; // host + from gesetzt
  fromDb: boolean; // Quelle ist tenant_setting (sonst ENV-Fallback)
}

type StoredSmtpValue = Partial<SmtpStored> & { password?: string };

function toSmtpConfig(stored: StoredSmtpValue, password: string): SmtpConfig {
  return {
    host: stored.host ?? '',
    port: typeof stored.port === 'number' ? stored.port : 587,
    secure: Boolean(stored.secure),
    user: stored.user ?? '',
    password,
    from: stored.from ?? '',
    replyTo: stored.replyTo ?? '',
  };
}

/** Für die Einstellungsoberfläche: ein unlesbares Passwort wird geloggt und leer angezeigt. */
export async function readSmtpConfig(ctx: TenantContext): Promise<SmtpConfig | null> {
  return withTenantContext(ctx, async (tx) => {
    const value = await readTenantSettingValue(tx, ctx.tenantId, KEY);
    if (value === undefined) return null;
    const stored = value as StoredSmtpValue;
    // Legacy-Klartext (stored.password) als Fallback; Decrypt-Fehler wird
    // geloggt statt still zu '' (Key-Rotation ohne Re-Wrap).
    const password = readEncryptedSetting(
      stored.passwordEncrypted,
      stored.password,
      'smtp.password',
      passwordContext(ctx.tenantId),
      (field, err) =>
        mailLog().warn(
          { component: 'secret-box', field, err: err.message },
          'readEncryptedSetting: Entschlüsselung fehlgeschlagen (Key-Rotation ohne Re-Wrap?)',
        ),
    );
    return toSmtpConfig(stored, password);
  });
}

/**
 * A7: Die gespeicherte Tenant-SMTP-Konfiguration ist für den Versand nicht
 * verwendbar — kein Objekt, ein Feld mit falschem Typ, ein ungültiger Port oder
 * ein nicht entschlüsselbares Passwort. Erkannt vor jedem SMTP-Kontakt.
 */
export class SmtpConfigInvalidError extends Error {
  readonly reason: 'shape' | 'password';
  constructor(reason: 'shape' | 'password', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SmtpConfigInvalidError';
    this.reason = reason;
  }
}

const TEXT_FIELDS = ['host', 'user', 'from', 'replyTo', 'passwordEncrypted', 'password'] as const;

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function storedForSend(value: unknown): StoredSmtpValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmtpConfigInvalidError('shape', 'Gespeicherte SMTP-Konfiguration ist kein Objekt.');
  }
  const record = value as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    if (!isAbsent(record[field]) && typeof record[field] !== 'string') {
      throw new SmtpConfigInvalidError('shape', `SMTP-Feld ${field} ist kein Text.`);
    }
  }
  const port = record['port'];
  if (
    !isAbsent(port) &&
    !(typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535)
  ) {
    throw new SmtpConfigInvalidError('shape', 'SMTP-Port ist ungültig.');
  }
  if (!isAbsent(record['secure']) && typeof record['secure'] !== 'boolean') {
    throw new SmtpConfigInvalidError('shape', 'SMTP-Verschlüsselungsangabe ist ungültig.');
  }
  return record as StoredSmtpValue;
}

function passwordForSend(stored: StoredSmtpValue, tenantId: string): string {
  const encrypted = stored.passwordEncrypted;
  if (!encrypted) return stored.password ?? '';
  if (!looksEncrypted(encrypted)) {
    throw new SmtpConfigInvalidError('password', 'Gespeichertes SMTP-Passwort ist kein Secret.');
  }
  try {
    return decryptSecret(encrypted, passwordContext(tenantId));
  } catch (error) {
    throw new SmtpConfigInvalidError('password', 'SMTP-Passwort ist nicht entschlüsselbar.', {
      cause: error,
    });
  }
}

/**
 * A7: Liest die Tenant-SMTP-Konfiguration für den Versand. Anders als
 * readSmtpConfig (Einstellungsoberfläche) wird ein unbrauchbarer Eintrag nicht
 * still zu Standardwerten oder einem leeren Passwort — sonst endete der
 * Versuch erst nach dem Verbindungsaufbau (Anmeldung ohne Passwort) mit einem
 * unklaren Ausgang. Wirft SmtpConfigInvalidError. Das Passwort wird nur für
 * eine vollständige Konfiguration (Host und Absender) gebraucht; eine
 * unvollständige behält den dokumentierten ENV-Fallback (F-05).
 */
export async function readSmtpConfigForSend(ctx: TenantContext): Promise<SmtpConfig | null> {
  const value = await withTenantContext(ctx, (tx) => readTenantSettingValue(tx, ctx.tenantId, KEY));
  if (value === undefined) return null;
  const stored = storedForSend(value);
  const complete = Boolean(stored.host && stored.from);
  return toSmtpConfig(stored, complete ? passwordForSend(stored, ctx.tenantId) : '');
}

export async function writeSmtpConfig(ctx: TenantContext, cfg: SmtpConfig): Promise<void> {
  await withTenantContext(ctx, (tx) => writeSmtpConfigTx(tx, ctx, cfg));
}

/** AUDIT-HASH-CHAIN-001: use the caller transaction to commit setting and audit together. */
export async function writeSmtpConfigTx(
  tx: TxClient,
  ctx: TenantContext,
  cfg: SmtpConfig,
): Promise<void> {
  const stored: SmtpStored = {
    host: cfg.host.trim(),
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user.trim(),
    passwordEncrypted: cfg.password
      ? encryptSecret(cfg.password, passwordContext(ctx.tenantId))
      : '',
    from: cfg.from.trim(),
    replyTo: cfg.replyTo.trim(),
  };
  await writeTenantSettingValue(tx, {
    tenantId: ctx.tenantId,
    key: KEY,
    value: stored as object,
    updatedBy: ctx.actorId,
  });
}

export async function deleteSmtpConfig(ctx: TenantContext): Promise<void> {
  await withTenantContext(ctx, (tx) => deleteSmtpConfigTx(tx, ctx));
}

/** AUDIT-HASH-CHAIN-001: use the caller transaction to commit setting and audit together. */
export async function deleteSmtpConfigTx(tx: TxClient, ctx: TenantContext): Promise<void> {
  await deleteTenantSettingValue(tx, ctx.tenantId, KEY);
}

/**
 * Status-Check ohne das Passwort zu entschlüsseln — für UI-Banner.
 */
export async function getSmtpStatus(ctx: TenantContext): Promise<SmtpStatus> {
  return withTenantContext(ctx, (tx) => getSmtpStatusTx(tx, ctx.tenantId));
}

/** Verwendet eine bereits geöffnete Tenant-Transaktion (kein zweiter Pool-Slot). */
export async function getSmtpStatusTx(
  tx: TenantSettingReader,
  tenantId: string,
): Promise<SmtpStatus> {
  const value = await readTenantSettingValue(tx, tenantId, KEY);
  const stored = value as Partial<SmtpStored> | undefined;
  if (stored?.host && stored.from) return { configured: true, fromDb: true };

  // Exakt wie sendMail(): Fehlt eine vollständige Tenant-Konfiguration, ist
  // die produktive ENV-Konfiguration die wirksame Quelle. Die Setup-Checkliste
  // darf einen bereits aktiven Mailversand daher nicht erneut verlangen.
  const configured = Boolean(env.SMTP_HOST.trim() && env.SMTP_FROM.trim());
  return { configured, fromDb: false };
}
