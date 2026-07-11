// =============================================================================
// DSGVO-Retention-Worker
//
// Setzt die maximalen Aufbewahrungsfristen aus docs/compliance/dsgvo-konzept.md
// (Abschnitt 2.2) durch — automatische Löschung/Pseudonymisierung von
// personenbezogenen Daten:
//
//   - notification          → 1 Jahr nach Erstellung  (löschen)
//   - phone_note            → 3 Jahre nach Erstellung  (löschen)
//   - client_contact.lastLoginAt → 2 Jahre nach letztem Login (Feld nullen,
//                             Kontakt selbst bleibt — nur der Zeitstempel ist
//                             das personenbezogene Datum)
//   - request (+ response)  → grundsätzlich 6 Jahre; bei referenzierten
//                             GoBD-Dokumenten gilt die längste zugehörige
//                             Dokumenttyp-Frist (6, 8 oder 10 Jahre).
//                             Rechnungen werden acht Jahre aufbewahrt.
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
import { Prisma } from '@prisma/client';
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
const REQUEST_GOBD_INVOICE_RETENTION_YEARS = 8;
const REQUEST_GOBD_LONG_RETENTION_YEARS = 10;
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
 * beginnt mit SCHLUSS DES maßgeblichen KALENDERJAHRES. Ein terminal
 * abgeschlossener Vorgang aus dem Jahr Y ist bis 31.12.(Y+years)
 * aufzubewahren und erst ab dem 1.1.(Y+years+1) löschbar.
 */
function requestPurgeCutoff(years: number): Date {
  return new Date(Date.UTC(new Date().getUTCFullYear() - years, 0, 1));
}

function linkedDocument(where: Prisma.DocumentWhereInput): Prisma.RequestWhereInput {
  return { responses: { some: { document: where } } };
}

// Der explizite Datei-Typ hat Vorrang vor der Carrier-Klassifikation. Eigene
// GoBD-Typen tragen als Carrier z. B. GOBD_TAX, können fachlich aber sechs oder
// acht Jahre haben. Nur Altbestand ohne documentTypeId fällt auf das Enum zurück.
const GOBD_EIGHT_YEAR_LINKED: Prisma.RequestWhereInput = linkedDocument({
  OR: [
    { documentType: { tier: 'GOBD', retentionYears: REQUEST_GOBD_INVOICE_RETENTION_YEARS } },
    { documentTypeId: null, classification: 'GOBD_INVOICE' },
  ],
});

const GOBD_TEN_YEAR_LINKED: Prisma.RequestWhereInput = linkedDocument({
  OR: [
    {
      documentType: {
        tier: 'GOBD',
        // Fail-safe für Alt-/Übergangsbestand: Ein GoBD-Typ ohne gepflegte
        // Frist wird nicht vorzeitig gelöscht.
        OR: [{ retentionYears: REQUEST_GOBD_LONG_RETENTION_YEARS }, { retentionYears: null }],
      },
    },
    {
      documentTypeId: null,
      classification: { in: ['GOBD_CONTRACT', 'GOBD_TAX'] },
    },
  ],
});

function terminalRequestAndResponsesBefore(cutoff: Date): Prisma.RequestWhereInput {
  return {
    status: { in: ['CLOSED', 'CANCELLED'] },
    OR: [
      { closedAt: { lt: cutoff } },
      // CANCELLED-Altbestand besitzt teils kein closedAt. updatedAt ist dann
      // der konservative Ersatz für das Abbruchdatum.
      { closedAt: null, updatedAt: { lt: cutoff } },
    ],
    // Eine später eingegangene Antwort darf nicht anhand des älteren
    // Abschluss-/Abbruchdatums zu früh mitgelöscht werden.
    responses: { none: { createdAt: { gte: cutoff } } },
  };
}

const SIX_YEAR_BUCKET: Prisma.RequestWhereInput = {
  // Ein expliziter GoBD-6-Jahres-Typ läuft zusammen mit Anforderungen ohne
  // GoBD-Bezug; nur die längeren Klassen werden hier ausgeschlossen.
  NOT: { OR: [GOBD_EIGHT_YEAR_LINKED, GOBD_TEN_YEAR_LINKED] },
};

const EIGHT_YEAR_BUCKET: Prisma.RequestWhereInput = {
  ...GOBD_EIGHT_YEAR_LINKED,
  // Bei mehreren Anhängen gewinnt immer die längste einschlägige Frist.
  NOT: GOBD_TEN_YEAR_LINKED,
};

const TEN_YEAR_BUCKET: Prisma.RequestWhereInput = {
  ...GOBD_TEN_YEAR_LINKED,
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
    const deletedCount = await prismaOwner.$transaction(async (tx) => {
      // Fail-closed gegen neue Antworten zwischen Kandidatensuche und Delete:
      // der FK-Check einer Response benötigt einen kollidierenden Key-Share-
      // Lock und wartet, bis diese Transaktion abgeschlossen ist.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "request" WHERE "id" IN (${Prisma.join(
          ids.map((id) => Prisma.sql`${id}::uuid`),
        )}) FOR UPDATE`,
      );

      const stillEligible = await tx.request.findMany({
        where: { AND: [where, { id: { in: ids } }] },
        select: { id: true },
      });
      const eligibleIds = stillEligible.map((r) => r.id);
      if (eligibleIds.length === 0) return 0;

      await tx.taxDeadline.updateMany({
        where: { requestId: { in: eligibleIds } },
        data: { requestId: null },
      });
      await tx.formSubmission.updateMany({
        where: { requestId: { in: eligibleIds } },
        data: { requestId: null },
      });
      const deleted = await tx.request.deleteMany({
        where: { AND: [where, { id: { in: eligibleIds } }] },
      });
      if (deleted.count !== eligibleIds.length) {
        // Ein verknüpfter Dokumenttyp kann sich trotz Request-Row-Lock ändern.
        // Dann alles zurückrollen statt Referenzen zu nullen oder zu früh zu löschen.
        throw new Error('RETENTION_RECHECK_CHANGED');
      }
      return deleted.count;
    });
    total += deletedCount;
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
    const requestGobdInvoiceCutoff = requestPurgeCutoff(REQUEST_GOBD_INVOICE_RETENTION_YEARS);
    const requestGobdLongCutoff = requestPurgeCutoff(REQUEST_GOBD_LONG_RETENTION_YEARS);

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

      // Requests werden nach der längsten Frist ihrer verknüpften Datei-Typen
      // klassifiziert. Der Response-Cutoff verhindert, dass eine jüngere
      // Antwort zusammen mit einem alten Request vorzeitig gelöscht wird.
      const requestsDeletedSixYear = await purgeRequests({
        tenantId,
        AND: [terminalRequestAndResponsesBefore(requestCutoff), SIX_YEAR_BUCKET],
      });
      const requestsDeletedEightYear = await purgeRequests({
        tenantId,
        AND: [terminalRequestAndResponsesBefore(requestGobdInvoiceCutoff), EIGHT_YEAR_BUCKET],
      });
      const requestsDeletedTenYear = await purgeRequests({
        tenantId,
        AND: [terminalRequestAndResponsesBefore(requestGobdLongCutoff), TEN_YEAR_BUCKET],
      });

      const counts = {
        notificationsDeleted: notifications.count,
        phoneNotesDeleted: phoneNotes.count,
        lastLoginCleared: lastLogins.count,
        requestsDeletedSixYear,
        requestsDeletedEightYear,
        requestsDeletedTenYear,
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
              requestGobdInvoiceCutoff: requestGobdInvoiceCutoff.toISOString(),
              requestGobdLongCutoff: requestGobdLongCutoff.toISOString(),
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
          requestGobdInvoiceCutoff: requestGobdInvoiceCutoff.toISOString(),
          requestGobdLongCutoff: requestGobdLongCutoff.toISOString(),
        },
        'dsgvo-retention',
      );
    }
  },
  { connection },
);
