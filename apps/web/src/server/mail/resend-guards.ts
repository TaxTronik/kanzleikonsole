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
};
