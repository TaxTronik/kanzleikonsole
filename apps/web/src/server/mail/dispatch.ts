// =============================================================================
// Re-Export aus @taxtronik/mail (Muster M-7, secret-box.ts).
//
// Der Mail-Dispatch lebt in packages/mail, damit auch der Worker
// mandantengerichtete Template-Mails versenden kann. K-10: Logger und
// n8n-Emitter registriert instrumentation.ts beim Serverstart
// (server/mail/integrations.ts) — dieser Import hat keine Seiteneffekte mehr.
// =============================================================================

export {
  sendTemplateMail,
  notifyClientContacts,
  renderTemplate,
  plainTextBody,
  notifyRequestOpened,
  requestOpenedMail,
  REQUEST_OPENED_FALLBACK,
  type TemplateFallback,
  type DispatchOptions,
  type RequestOpenedInput,
} from '@taxtronik/mail';
