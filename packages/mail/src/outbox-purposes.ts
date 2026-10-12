// =============================================================================
// Anlässe der Mail-Outbox (Review-Befund F-08) — ohne Abhängigkeiten, damit
// auch Client-Komponenten die Bezeichnungen für die Statusanzeige nutzen können.
// =============================================================================

/** Fachlicher Anlass eines Versandauftrags (Statusanzeige, Kanzlei-Hinweis). */
export const MAIL_OUTBOX_PURPOSES = [
  'invoice-sent',
  'invoice-external',
  'handover-ready',
  'request-opened',
  'request-staff-replied',
  'gwg-activated',
  'gwg-invite',
  'appointment-confirmed',
  'appointment-rejected',
  'form-sent',
  'appointment-changed',
  'appointment-cancelled',
] as const;

export type MailOutboxPurpose = (typeof MAIL_OUTBOX_PURPOSES)[number];

export const MAIL_OUTBOX_PURPOSE_LABELS: Readonly<Record<MailOutboxPurpose, string>> = {
  'invoice-sent': 'Rechnungsmail',
  'invoice-external': 'Rechnungsmail mit PDF',
  'handover-ready': 'Abholbenachrichtigung',
  'request-opened': 'Mail zur neuen Anforderung',
  'request-staff-replied': 'Mail zur Kanzlei-Antwort',
  'gwg-activated': 'Begrüßungsmail nach GwG-Freigabe',
  'gwg-invite': 'GwG-Einladung',
  'appointment-confirmed': 'Terminbestätigung',
  'appointment-rejected': 'Terminabsage',
  'form-sent': 'Mail zum neuen Formular',
  'appointment-changed': 'Terminänderung',
  'appointment-cancelled': 'Absage des Termins',
};

/**
 * Welle 15: Anlässe, die für denselben Vorgang mehrfach ausgelöst werden können
 * (jede Terminänderung) und je Auslösung an mehrere Einzeladressen gehen. Für
 * den Zustellstatus zählt nur die jüngste Auslösung (gleicher created_at).
 */
export const MAIL_OUTBOX_LATEST_BATCH_PURPOSES: ReadonlySet<string> = new Set([
  'appointment-changed',
  'appointment-cancelled',
]);

/** Vorgang, an dem der Zustellstatus angezeigt wird. */
export type MailOutboxResourceType =
  | 'invoice'
  | 'client_handover'
  | 'request'
  | 'gwg_check'
  | 'gwg_onboarding_invite'
  | 'appointment_request'
  | 'appointment'
  | 'form_submission';
