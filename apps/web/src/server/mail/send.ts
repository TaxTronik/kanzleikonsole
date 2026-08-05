// =============================================================================
// Re-Export aus @taxtronik/mail (Muster M-7, secret-box.ts).
//
// SMTP-Transport lebt jetzt in packages/mail (geteilt mit dem Worker).
// Bestehende Imports `from '@/server/mail/send'` bleiben unverändert gültig.
// =============================================================================

export { sendMail, sendTestMail, type MailAttachment, type MailOptions } from '@taxtronik/mail';
