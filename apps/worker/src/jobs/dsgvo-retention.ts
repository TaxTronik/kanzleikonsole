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
//
// Audit-Nachweis: Datenvernichtung braucht einen Vernichtungsvermerk in der
// Hash-Chain (Art. 5 Abs. 2 — analog gwg.check.destroy: nur Zähler, keine
// Personendaten). Die Löschungen laufen daher PRO TENANT; hat ein Lauf für
// einen Tenant etwas vernichtet, schreibt er EIN zusammenfassendes Event
// 'dsgvo.retention.run' (Zähler je Datenklasse + Cutoffs) in dessen Chain.
// Läufe ohne Treffer schreiben kein Event (kein tägliches Chain-Rauschen).
// =============================================================================

import { Worker } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';

// RF-8: record() braucht nur den Tx — gleiches Muster wie poa-expiry-check.ts.
const evidence = new EvidenceService(new LocalTimestampAdapter());

const NOTIFICATION_RETENTION_YEARS = 1;
const PHONE_NOTE_RETENTION_YEARS = 3;
const LAST_LOGIN_RETENTION_YEARS = 2;
const REQUEST_RETENTION_YEARS = 6;
const REQUEST_GOBD_RETENTION_YEARS = 10;
const REQUEST_PURGE_BATCH = 500;

/** Datum vor `years` Jahren (schaltjahr-korrekt). Für Fristen OHNE
 *  Kalenderjahres-Anker (Notifications, Phone-Notes, lastLoginAt). */
function yearsAgo(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

/**
 * Cutoff für aufbewahrungspflichtige Requests: § 147 Abs. 4 AO — die Frist
 * beginnt mit SCHLUSS DES KALENDERJAHRES der Entstehung, nicht mit dem
 * Erstellungsdatum. Ein Request aus dem Jahr Y ist bis 31.12.(Y+years)
 * aufzubewahren und erst ab dem 1.1.(Y+years+1) löschbar. Gelöscht werden also
 * nur Requests mit `createdAt` VOR dem 1.1.(aktuelles Jahr − years).
 * Beispiel (years=10): Request vom 15.03.2026 → löschbar erst ab 01.01.2037.
 */
function requestPurgeCutoff(years: number): Date {
  return new Date(Date.UTC(new Date().getUTCFullYear() - years, 0, 1));
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
  async (job) => {
    const notifCutoff = yearsAgo(NOTIFICATION_RETENTION_YEARS);
    const phoneCutoff = yearsAgo(PHONE_NOTE_RETENTION_YEARS);
    const loginCutoff = yearsAgo(LAST_LOGIN_RETENTION_YEARS);
    const requestCutoff = requestPurgeCutoff(REQUEST_RETENTION_YEARS);
    const requestGobdCutoff = requestPurgeCutoff(REQUEST_GOBD_RETENTION_YEARS);

    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    for (const tenantId of tenantIds) {
      const notifications = await prismaOwner.notification.deleteMany({
        where: { tenantId, createdAt: { lt: notifCutoff } },
      });
      const phoneNotes = await prismaOwner.phoneNote.deleteMany({
        where: { tenantId, createdAt: { lt: phoneCutoff } },
      });
      const lastLogins = await prismaOwner.clientContact.updateMany({
        where: { tenantId, lastLoginAt: { lt: loginCutoff } },
        data: { lastLoginAt: null },
      });

      // Requests ohne GoBD-Bezug nach 6 Jahren, mit GoBD-Bezug erst nach 10.
      const requestsNonGobd = await purgeRequests({
        tenantId,
        createdAt: { lt: requestCutoff },
        NOT: GOBD_LINKED,
      });
      const requestsGobd = await purgeRequests({
        tenantId,
        createdAt: { lt: requestGobdCutoff },
        ...GOBD_LINKED,
      });

      const counts = {
        notificationsDeleted: notifications.count,
        phoneNotesDeleted: phoneNotes.count,
        lastLoginCleared: lastLogins.count,
        requestsDeletedNonGobd: requestsNonGobd,
        requestsDeletedGobd: requestsGobd,
      };
      const totalAffected = Object.values(counts).reduce((a, b) => a + b, 0);

      // Vernichtungsvermerk: ein Event pro Lauf+Tenant. Nachgelagert (nicht in
      // einer Tx mit den Löschungen): purgeRequests ist über mehrere Batch-Txen
      // verteilt, die Zähler stehen erst nach Abschluss fest.
      if (totalAffected > 0) {
        await withWorkerTenantContext(tenantId, async (tx) => {
          await evidence.record(tx, {
            tenantId,
            actorType: 'SYSTEM',
            actorId: null,
            action: 'dsgvo.retention.run',
            resourceType: 'tenant',
            resourceId: tenantId,
            after: {
              ...counts,
              notifCutoff: notifCutoff.toISOString(),
              phoneCutoff: phoneCutoff.toISOString(),
              loginCutoff: loginCutoff.toISOString(),
              requestCutoff: requestCutoff.toISOString(),
              requestGobdCutoff: requestGobdCutoff.toISOString(),
            },
          });
        });
      }

      log.info(
        {
          tenantId,
          ...counts,
          notifCutoff: notifCutoff.toISOString(),
          phoneCutoff: phoneCutoff.toISOString(),
          loginCutoff: loginCutoff.toISOString(),
          requestCutoff: requestCutoff.toISOString(),
          requestGobdCutoff: requestGobdCutoff.toISOString(),
        },
        'dsgvo-retention',
      );
    }
  },
  { connection },
);
