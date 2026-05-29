// =============================================================================
// DSGVO-Retention-Worker
//
// Setzt die maximalen Aufbewahrungsfristen aus docs/compliance/dsgvo-konzept.md
// (Abschnitt 2.2) durch — automatische Löschung/Pseudonymisierung von
// personenbezogenen Daten OHNE GoBD-/Aufbewahrungsbezug:
//
//   - notification          → 1 Jahr nach Erstellung  (löschen)
//   - phone_note            → 3 Jahre nach Erstellung  (löschen)
//   - client_contact.lastLoginAt → 2 Jahre nach letztem Login (Feld nullen,
//                             Kontakt selbst bleibt — nur der Zeitstempel ist
//                             das personenbezogene Datum)
//
// BEWUSST NICHT hier (siehe dsgvo-konzept.md): Anforderungen/Antworten
// (6 Jahre, „ohne GoBD-Bezug") — die GoBD-Bezug-Abgrenzung + lose Referenzen
// (tax_deadline.request_id, form_submission.request_id) brauchen erst eine
// fachliche Festlegung, bevor automatisch gelöscht wird.
//
// Fristen leap-year-korrekt über setFullYear (nicht n*365 Tage).
// Idempotent: doppelte Ausführung pro Tag ist ein no-op (zweiter Lauf findet
// nichts mehr jenseits des Cutoffs). prismaOwner, weil systemweite Wartung
// über alle Tenants (wie magic-link-cleanup) — bewusst BYPASSRLS.
// =============================================================================

import { Worker } from 'bullmq';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

const NOTIFICATION_RETENTION_YEARS = 1;
const PHONE_NOTE_RETENTION_YEARS = 3;
const LAST_LOGIN_RETENTION_YEARS = 2;

/** Datum vor `years` Jahren (schaltjahr-korrekt). */
function yearsAgo(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

export const dsgvoRetentionWorker = new Worker<ChecksJob>(
  'dsgvo-retention',
  async () => {
    const notifCutoff = yearsAgo(NOTIFICATION_RETENTION_YEARS);
    const phoneCutoff = yearsAgo(PHONE_NOTE_RETENTION_YEARS);
    const loginCutoff = yearsAgo(LAST_LOGIN_RETENTION_YEARS);

    const notifications = await prismaOwner.notification.deleteMany({
      where: { createdAt: { lt: notifCutoff } },
    });
    const phoneNotes = await prismaOwner.phoneNote.deleteMany({
      where: { createdAt: { lt: phoneCutoff } },
    });
    const lastLogins = await prismaOwner.clientContact.updateMany({
      where: { lastLoginAt: { lt: loginCutoff } },
      data: { lastLoginAt: null },
    });

    log.info(
      {
        notificationsDeleted: notifications.count,
        phoneNotesDeleted: phoneNotes.count,
        lastLoginCleared: lastLogins.count,
        notifCutoff: notifCutoff.toISOString(),
        phoneCutoff: phoneCutoff.toISOString(),
        loginCutoff: loginCutoff.toISOString(),
      },
      'dsgvo-retention',
    );
  },
  { connection },
);
