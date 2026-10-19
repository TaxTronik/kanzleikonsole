// =============================================================================
// Gate für „Erneut senden" je Anlass (Review-Entscheidung C4) — wie bei der
// Action, die die Mail ausgelöst hat. Ohne Laufzeitabhängigkeiten, damit
// Server-Action und Tests dieselbe Tabelle verwenden.
// =============================================================================

import type { MailOutboxPurpose } from '@taxtronik/mail/outbox-purposes';
import type { StaffGuardOptions } from '@/server/actions/staff-action';

/**
 * Rechnungsversand und externe Rechnung: INVOICE_SEND im Rechnungsmodul.
 * Anlieferung, Termine und Formulare: das jeweilige Modul. Anforderungen und
 * GwG: angemeldete Kanzlei. Mandantenzugriff und für die Begrüßung nach der
 * Freischaltung den zugeordneten Berufsträger prüft resendMailOutboxTx.
 */
export const MAIL_RESEND_GUARDS: Readonly<Record<MailOutboxPurpose, StaffGuardOptions>> = {
  'invoice-sent': { requirePermission: 'INVOICE_SEND', modeModule: 'invoices' },
  'invoice-external': { requirePermission: 'INVOICE_SEND', modeModule: 'invoices' },
  'handover-ready': { module: 'handovers' },
  'request-opened': {},
  'request-staff-replied': {},
  'gwg-activated': {},
  'gwg-invite': {},
  'appointment-confirmed': { module: 'appointments' },
  'appointment-rejected': { module: 'appointments' },
  'form-sent': { module: 'forms' },
  'appointment-changed': { module: 'appointments' },
  'appointment-cancelled': { module: 'appointments' },
  // TCMS Stufe 4: kein Neuversand (Inhalt und Code sind mit dem Endstatus
  // entfernt; resendMailOutboxTx lehnt ab). Das Gate bleibt eng.
  'tcms-freigabe-angefordert': { module: 'tcms', requireAdmin: true },
  'tcms-freigabe-code': { module: 'tcms', requireAdmin: true },
  'tcms-freigabe-neu-adressiert': { module: 'tcms', requireAdmin: true },
};
