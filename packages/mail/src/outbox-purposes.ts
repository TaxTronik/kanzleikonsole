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
  // TCMS Stufe 4: Mitteilungen des Tax-CMS an Mandantenkontakte (= System-Slug,
  // Liste TCMS_MAIL_ANLAESSE in tcms-vorlagen.ts).
  'tcms-freigabe-angefordert',
  'tcms-freigabe-code',
  'tcms-freigabe-neu-adressiert',
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
  'tcms-freigabe-angefordert': 'Tax-CMS: Mail zur angeforderten Freigabe',
  'tcms-freigabe-code': 'Tax-CMS: Mail mit Bestätigungscode',
  'tcms-freigabe-neu-adressiert': 'Tax-CMS: Mail zur neu adressierten Freigabe',
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
  | 'form_submission'
  /** TCMS Stufe 4: Zustellzeile einer Mitteilung des Tax-CMS (tcms_nachricht_zustellung.id). */
  | 'tcms_nachricht';

/**
 * TCMS Stufe 4: Vorgangstypen, deren Aufträge Inhalt und geheime Variablen mit
 * JEDEM Endstatus verlieren, auch bei FAILED/UNKNOWN. Für sie gibt es kein
 * „Erneut senden“: Ein Bestätigungscode soll nach dem Versand nicht in der
 * Datenbank bleiben, und das Tax-CMS stellt bei Bedarf eine neue Mitteilung
 * (neuer Code, Neuadressierung). Die Datenbank erzwingt dasselbe
 * (mail_outbox_tcms_content_check).
 */
export const MAIL_OUTBOX_NO_RESEND_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'tcms_nachricht',
]);
