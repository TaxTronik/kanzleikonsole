// =============================================================================
// @taxtronik/mail — Public API
//
// Extrahierter Mail-Stack (vormals apps/web/src/server/mail + settings), damit
// Web UND Worker mandantengerichtete Template-Mails über EINE Implementierung
// versenden. Die Web-Dateien bleiben als Re-Exports erhalten (Muster M-7,
// secret-box.ts).
//
// K-10: Logger und n8n-Emitter registriert jeder Prozess explizit beim Start
// (Web: instrumentation.ts → registerMailIntegrations, Worker: index.ts →
// registerWorkerMailIntegrations) — nicht mehr als Import-Seiteneffekt. Fehlt
// die Registrierung, bricht ein Versand im Modus BOTH vor dem SMTP-Kontakt mit
// MailN8nEmitterMissingError ab, statt das Ereignis still auszulassen.
// =============================================================================

export {
  sendMail,
  sendTestMail,
  SmtpConfigUnavailableError,
  type MailAttachment,
  type MailOptions,
} from './send';
export {
  sendTemplateMail,
  notifyClientContacts,
  renderTemplate,
  plainTextBody,
  type TemplateFallback,
  type TemplateMailResult,
  type ContactNotificationResult,
  type ContactDispatchOptions,
  type DispatchOptions,
} from './dispatch';
export {
  notifyRequestOpened,
  requestOpenedMail,
  notifyAutomaticTaxRequestOpened,
  REQUEST_OPENED_FALLBACK,
  AUTOMATIC_TAX_REQUEST_OPENED_FALLBACK,
  type RequestOpenedInput,
  type AutomaticTaxRequestOpenedInput,
} from './request-opened';
export {
  readSmtpConfig,
  writeSmtpConfig,
  writeSmtpConfigTx,
  deleteSmtpConfig,
  deleteSmtpConfigTx,
  getSmtpStatus,
  getSmtpStatusTx,
  DEFAULT_SMTP_CONFIG,
  type SmtpConfig,
  type SmtpStatus,
} from './smtp-settings';
export {
  readMailDispatch,
  writeMailDispatch,
  writeMailDispatchTx,
  DEFAULT_DISPATCH,
  type MailDispatchMode,
  type MailDispatchConfig,
} from './dispatch-settings';
export { renderSafeMarkdown, escapeMarkdownVariable } from './markdown';
export { escapeHtml, safeHref } from './markdown-safety';
export { setMailLogger, mailLog, type MailLogger } from './logger';
export {
  setN8nEmitter,
  hasN8nEmitter,
  resetN8nEmitterForTests,
  MailN8nEmitterMissingError,
  type MailN8nEmitter,
  type MailN8nEmitOptions,
} from './n8n-emitter';
