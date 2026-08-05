// =============================================================================
// @taxtronik/mail — Public API
//
// Extrahierter Mail-Stack (vormals apps/web/src/server/mail + settings), damit
// Web UND Worker mandantengerichtete Template-Mails über EINE Implementierung
// versenden. Die Web-Dateien bleiben als Re-Exports erhalten (Muster M-7,
// secret-box.ts) und registrieren beim Laden Logger + n8n-Emitter.
//
// KONVENTION (Web): immer über die Re-Export-Pfade importieren
// (@/server/mail/dispatch usw.) — ein Direktimport aus @taxtronik/mail würde
// die Registrierung des n8n-Emitters umgehen (Mode BOTH bliebe ohne Event).
// =============================================================================

export { sendMail, sendTestMail, type MailAttachment, type MailOptions } from './send';
export {
  sendTemplateMail,
  notifyClientContacts,
  renderTemplate,
  plainTextBody,
  type TemplateFallback,
  type DispatchOptions,
} from './dispatch';
export {
  notifyRequestOpened,
  REQUEST_OPENED_FALLBACK,
  type RequestOpenedInput,
} from './request-opened';
export {
  readSmtpConfig,
  writeSmtpConfig,
  deleteSmtpConfig,
  getSmtpStatus,
  DEFAULT_SMTP_CONFIG,
  type SmtpConfig,
  type SmtpStatus,
} from './smtp-settings';
export {
  readMailDispatch,
  writeMailDispatch,
  DEFAULT_DISPATCH,
  type MailDispatchMode,
  type MailDispatchConfig,
} from './dispatch-settings';
export { renderSafeMarkdown, escapeMarkdownVariable } from './markdown';
export { escapeHtml, safeHref } from './markdown-safety';
export { setMailLogger, mailLog, type MailLogger } from './logger';
export { setN8nEmitter, type MailN8nEmitter } from './n8n-emitter';
