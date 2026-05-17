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

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { decryptSecret, encryptSecret, looksEncrypted } from '@/server/crypto/secret-box';

const KEY = 'mail.smtp';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;     // True für Port 465 (TLS), sonst STARTTLS opportunistisch
  user: string;        // Login (oft = From-Adresse)
  password: string;    // Klartext (im DB-Roundtrip verschlüsselt)
  from: string;        // "Kanzlei Mustermann <kanzlei@example.de>"
  replyTo: string;     // Optional
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

export interface SmtpStatus {
  configured: boolean;  // host + from gesetzt
  fromDb: boolean;      // Quelle ist tenant_setting (sonst ENV-Fallback)
}

export async function readSmtpConfig(ctx: TenantContext): Promise<SmtpConfig | null> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
    });
    if (!row) return null;
    const stored = row.value as Partial<SmtpStored> & { password?: string };
    let password = '';
    if (stored.passwordEncrypted && looksEncrypted(stored.passwordEncrypted)) {
      try {
        password = decryptSecret(stored.passwordEncrypted);
      } catch {
        password = '';
      }
    } else if (typeof stored.password === 'string') {
      // Legacy / fehlgeschlagene Migration: behandle als Klartext, wird beim
      // nächsten Speichern verschlüsselt.
      password = stored.password;
    }
    return {
      host: stored.host ?? '',
      port: typeof stored.port === 'number' ? stored.port : 587,
      secure: Boolean(stored.secure),
      user: stored.user ?? '',
      password,
      from: stored.from ?? '',
      replyTo: stored.replyTo ?? '',
    };
  });
}

export async function writeSmtpConfig(ctx: TenantContext, cfg: SmtpConfig): Promise<void> {
  const stored: SmtpStored = {
    host: cfg.host.trim(),
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user.trim(),
    passwordEncrypted: cfg.password ? encryptSecret(cfg.password) : '',
    from: cfg.from.trim(),
    replyTo: cfg.replyTo.trim(),
  };
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY,
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}

export async function deleteSmtpConfig(ctx: TenantContext): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.deleteMany({
      where: { tenantId: ctx.tenantId, key: KEY },
    });
  });
}

/**
 * Status-Check ohne das Passwort zu entschlüsseln — für UI-Banner.
 */
export async function getSmtpStatus(ctx: TenantContext): Promise<SmtpStatus> {
  const row = await withTenantContext(ctx, (tx) =>
    tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
      select: { value: true },
    }),
  );
  if (!row) return { configured: false, fromDb: false };
  const stored = row.value as Partial<SmtpStored>;
  const configured = Boolean(stored.host && stored.from);
  return { configured, fromDb: true };
}
