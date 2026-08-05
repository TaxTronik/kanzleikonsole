// =============================================================================
// Re-Export aus @taxtronik/mail (Muster M-7, secret-box.ts).
//
// Der Dispatch-Modus (tenant_setting `mail.dispatch`, APP | BOTH) lebt jetzt
// in packages/mail. Bestehende Imports bleiben unverändert gültig.
// =============================================================================

export {
  readMailDispatch,
  writeMailDispatch,
  DEFAULT_DISPATCH,
  type MailDispatchMode,
  type MailDispatchConfig,
} from '@taxtronik/mail';
