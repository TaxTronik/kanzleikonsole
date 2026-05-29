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
//   - request (+ response)  → 6 Jahre OHNE GoBD-Bezug, 10 Jahre MIT GoBD-Bezug.
//                             GoBD-Bezug = eine Antwort referenziert ein
//                             Dokument mit documentType.tier = GOBD oder
//                             classification GOBD_* (dann gilt die 10-Jahres-
//                             Frist § 147 AO statt der DSGVO-Minimierung).
//
// Request-Löschung: RequestResponse hängt per onDelete:Cascade am Request und
// geht automatisch mit. Das referenzierte Dokument bleibt (eigene Object-Lock-
// Retention). tax_deadline.request_id und form_submission.request_id sind lose
// Spalten ohne FK — sie würden sonst verwaisen, daher werden sie pro Batch in
// derselben Transaktion zuerst genullt.
//
// Fristen leap-year-korrekt über setFullYear (nicht n*365 Tage).
// Idempotent: doppelte Ausführung pro Tag ist ein no-op (zweiter Lauf findet
// nichts mehr jenseits des Cutoffs). prismaOwner, weil systemweite Wartung
// über alle Tenants (wie magic-link-cleanup) — bewusst BYPASSRLS.
// =============================================================================

import { Worker } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

const NOTIFICATION_RETENTION_YEARS = 1;
const PHONE_NOTE_RETENTION_YEARS = 3;
const LAST_LOGIN_RETENTION_YEARS = 2;
const REQUEST_RETENTION_YEARS = 6;
const REQUEST_GOBD_RETENTION_YEARS = 10;
const REQUEST_PURGE_BATCH = 500;

/** Datum vor `years` Jahren (schaltjahr-korrekt). */
function yearsAgo(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

// GoBD-Bezug: mindestens eine Antwort referenziert ein GoBD-relevantes Dokument.
const GOBD_LINKED: Prisma.RequestWhereInput = {
  responses: {
    some: {
      document: {
        OR: [
          { documentType: { tier: 'GOBD' } },
          { classification: { in: ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'] } },
        ],
      },
    },
  },
};

/**
 * Löscht Requests (Cascade auf responses) in Batches. Vorher werden die losen
 * Rückverweise (tax_deadline / form_submission) in derselben Transaktion
 * genullt, damit keine verwaisten request_id-Spalten zurückbleiben.
 */
async function purgeRequests(where: Prisma.RequestWhereInput): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = await prismaOwner.request.findMany({
      where,
      select: { id: true },
      take: REQUEST_PURGE_BATCH,
    });
    if (batch.length === 0) break;
    const ids = batch.map((r) => r.id);
    await prismaOwner.$transaction([
      prismaOwner.taxDeadline.updateMany({ where: { requestId: { in: ids } }, data: { requestId: null } }),
      prismaOwner.formSubmission.updateMany({ where: { requestId: { in: ids } }, data: { requestId: null } }),
      prismaOwner.request.deleteMany({ where: { id: { in: ids } } }),
    ]);
    total += ids.length;
    if (batch.length < REQUEST_PURGE_BATCH) break;
  }
  return total;
}

export const dsgvoRetentionWorker = new Worker<ChecksJob>(
  'dsgvo-retention',
  async () => {
    const notifCutoff = yearsAgo(NOTIFICATION_RETENTION_YEARS);
    const phoneCutoff = yearsAgo(PHONE_NOTE_RETENTION_YEARS);
    const loginCutoff = yearsAgo(LAST_LOGIN_RETENTION_YEARS);
    const requestCutoff = yearsAgo(REQUEST_RETENTION_YEARS);
    const requestGobdCutoff = yearsAgo(REQUEST_GOBD_RETENTION_YEARS);

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

    // Requests ohne GoBD-Bezug nach 6 Jahren, mit GoBD-Bezug erst nach 10.
    const requestsNonGobd = await purgeRequests({
      createdAt: { lt: requestCutoff },
      NOT: GOBD_LINKED,
    });
    const requestsGobd = await purgeRequests({
      createdAt: { lt: requestGobdCutoff },
      ...GOBD_LINKED,
    });

    log.info(
      {
        notificationsDeleted: notifications.count,
        phoneNotesDeleted: phoneNotes.count,
        lastLoginCleared: lastLogins.count,
        requestsDeletedNonGobd: requestsNonGobd,
        requestsDeletedGobd: requestsGobd,
        notifCutoff: notifCutoff.toISOString(),
        phoneCutoff: phoneCutoff.toISOString(),
        loginCutoff: loginCutoff.toISOString(),
        requestCutoff: requestCutoff.toISOString(),
        requestGobdCutoff: requestGobdCutoff.toISOString(),
      },
      'dsgvo-retention',
    );
  },
  { connection },
);
