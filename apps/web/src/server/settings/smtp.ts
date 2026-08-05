// =============================================================================
// Re-Export aus @taxtronik/mail (Muster M-7, secret-box.ts).
//
// Die SMTP-Settings (tenant_setting `mail.smtp`) leben jetzt in packages/mail,
// damit der Worker die Tenant-Konfiguration für den Mail-Versand lesen kann.
// Bestehende Imports `from '@/server/settings/smtp'` bleiben unverändert.
// =============================================================================

export {
  readSmtpConfig,
  writeSmtpConfig,
  deleteSmtpConfig,
  getSmtpStatus,
  DEFAULT_SMTP_CONFIG,
  type SmtpConfig,
  type SmtpStatus,
} from '@taxtronik/mail';
