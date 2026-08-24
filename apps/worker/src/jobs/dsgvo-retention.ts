// =============================================================================
// DSGVO-Retention-Worker
//
// Setzt die maximalen Aufbewahrungsfristen aus docs/compliance/dsgvo-konzept.md
// (Abschnitt 2.2) durch — automatische Löschung/Pseudonymisierung von
// personenbezogenen Daten:
//
//   - notification          → 1 Jahr nach Erstellung  (löschen)
//   - tax_deadline_notification_history → max. 1 Jahr nach Archivierung
//                             (pseudonymen technischen Nachweis löschen)
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
// derselben Transaktion zuerst genullt. Bei einer bereits terminalisierten
// Auto-Benachrichtigung ist tax_deadline.request_id schon leer; ihre stabile
// Herkunft wird vor dem Request-Delete über request.tax_deadline_id aufgelöst.
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
 * Löscht Requests (Cascade auf responses) in Batches. Tax-Deadline-Verweise
 * werden vorher genullt. Bei Formularen bleibt bzw. entsteht dagegen bewusst
 * ein nicht auflösbarer request_id-Tombstone: PENDING/DRAFT darf nach der
 * Retention eines terminalen Requests niemals wieder als stand-alone offen
 * erscheinen. Portal, Actions und SQL-Discard behandeln den fehlenden
 * expliziten Request deshalb einheitlich fail-closed.
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
      // Portal-Formularaktionen sperren Submission → Request. Dieselbe
      // Reihenfolge verhindert einen Deadlock, wenn Retention und ein letzter
      // Portalzugriff gleichzeitig laufen. Sowohl der explizite request_id-
      // Link als auch der ältere Request-Rücklink werden berücksichtigt.
      await tx.$queryRaw(
        Prisma.sql`
          SELECT submission."id"
            FROM "form_submission" AS submission
           WHERE submission."request_id" IN (
                   ${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}
                 )
              OR submission."id" IN (
                   SELECT request."form_submission_id"
                     FROM "request" AS request
                    WHERE request."id" IN (
                            ${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}
                          )
                      AND request."form_submission_id" IS NOT NULL
                 )
           ORDER BY submission."id"
           FOR UPDATE
        `,
      );
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
        // Die Request-Zeilen sind bereits FOR UPDATE gesperrt. Damit ist auch
        // taxDeadlineId bis zum Delete stabil und kann eine zuvor vom Worker
        // nach ORPHANED entkoppelte Deadline weiterhin sicher identifizieren.
        select: { id: true, taxDeadlineId: true },
      });
      const eligibleIds = stillEligible.map((r) => r.id);
      if (eligibleIds.length === 0) return 0;
      const eligibleTaxDeadlineIds = Array.from(
        new Set(
          stillEligible
            .map((request) => request.taxDeadlineId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      );

      // Pointer-Zeilen und bereits ORPHANED gewordene Ursprungszeilen werden
      // in fester Reihenfolge gesperrt. So kann zwischen Recheck,
      // Neutralisierung und Request-Delete weder ein Worker-Abschluss noch
      // eine neue Verknüpfung denselben Deadline-Zustand umhängen.
      const originDeadlineFilter =
        eligibleTaxDeadlineIds.length > 0
          ? Prisma.sql`OR deadline."id" IN (${Prisma.join(
              eligibleTaxDeadlineIds.map((id) => Prisma.sql`${id}::uuid`),
            )})`
          : Prisma.sql``;
      await tx.$queryRaw(
        Prisma.sql`
          SELECT deadline."id"
            FROM "tax_deadline" AS deadline
           WHERE deadline."request_id" IN (
                   ${Prisma.join(eligibleIds.map((id) => Prisma.sql`${id}::uuid`))}
                 )
              ${originDeadlineFilter}
           ORDER BY deadline."id"
           FOR UPDATE
        `,
      );

      // Der Unlink-Trigger akzeptiert eine vollständige Neutralisierung nur
      // mit dieser transaktionslokalen, expliziten Purge-Freigabe. Ein
      // laufender UNKNOWN-Versandclaim bleibt auch dann fail-closed gesperrt.
      await tx.$queryRaw(
        Prisma.sql`SELECT set_config('app.tax_deadline_notification_purge', 'on', true)`,
      );
      const neutralizedDeadlines = await tx.taxDeadline.updateMany({
        where: {
          OR: [
            // Noch bestehender technischer Pointer.
            { requestId: { in: eligibleIds } },
            // Der Worker kann den Pointer bereits terminal nach ORPHANED
            // gelöst haben. Request.taxDeadlineId bewahrt bis zum Purge die
            // stabile Herkunft; nur dieser explizite Zustand wird hier über
            // die asymmetrische Relation neutralisiert.
            ...(eligibleTaxDeadlineIds.length > 0
              ? [
                  {
                    id: { in: eligibleTaxDeadlineIds },
                    requestId: null,
                    autoRequestNotificationStatus: 'ORPHANED' as const,
                  },
                ]
              : []),
          ],
        },
        data: {
          // TAX-DEADLINE-AUTOREQUEST-001: Beim DSGVO-Purge verschwindet die
          // fachliche Request-Verknuepfung. Der davon getrennte technische
          // Benachrichtigungszustand muss in derselben Transaktion neutralisiert
          // werden; sonst bliebe eine Provider-Aussage ohne Bezugsobjekt stehen.
          requestId: null,
          autoRequestNotificationStatus: 'NOT_REQUIRED',
          autoRequestNotificationAttemptCount: 0,
          autoRequestNotificationLastAttemptAt: null,
          autoRequestNotificationNextAttemptAt: null,
          autoRequestNotificationAcceptedAt: null,
          autoRequestNotificationLastError: null,
          autoRequestNotificationEscalatedAt: null,
        },
      });
      if (neutralizedDeadlines.count < eligibleTaxDeadlineIds.length) {
        // Jede stabile Auto-Request-Herkunft muss vor dem Delete entweder als
        // Pointer- oder als ORPHANED-Zeile vollständig neutralisiert worden
        // sein. Bei inkonsistentem Altbestand wird der gesamte Batch
        // zurückgerollt, statt die letzte Zuordnung zur Versandhistorie zu
        // vernichten.
        throw new Error('RETENTION_TAX_DEADLINE_NEUTRALIZATION_CHANGED');
      }
      if (eligibleTaxDeadlineIds.length > 0) {
        const neutralizedOrigins = await tx.taxDeadline.findMany({
          where: { id: { in: eligibleTaxDeadlineIds } },
          select: {
            id: true,
            requestId: true,
            autoRequestNotificationStatus: true,
            autoRequestNotificationAttemptCount: true,
            autoRequestNotificationLastAttemptAt: true,
            autoRequestNotificationNextAttemptAt: true,
            autoRequestNotificationAcceptedAt: true,
            autoRequestNotificationLastError: true,
            autoRequestNotificationEscalatedAt: true,
          },
        });
        const originById = new Map(neutralizedOrigins.map((deadline) => [deadline.id, deadline]));
        const everyStableOriginNeutralized = eligibleTaxDeadlineIds.every((deadlineId) => {
          const deadline = originById.get(deadlineId);
          return (
            deadline?.requestId === null &&
            deadline.autoRequestNotificationStatus === 'NOT_REQUIRED' &&
            deadline.autoRequestNotificationAttemptCount === 0 &&
            deadline.autoRequestNotificationLastAttemptAt === null &&
            deadline.autoRequestNotificationNextAttemptAt === null &&
            deadline.autoRequestNotificationAcceptedAt === null &&
            deadline.autoRequestNotificationLastError === null &&
            deadline.autoRequestNotificationEscalatedAt === null
          );
        });
        if (!everyStableOriginNeutralized) {
          // Ein aggregierter Update-Count kann einen verfehlten Ursprung durch
          // eine zusätzlich aktualisierte Legacy-Pointer-Zeile verdecken. Erst
          // der vollständige Nachzustand jedes stabilen Origins autorisiert den
          // anschließenden Request-Delete.
          throw new Error('RETENTION_TAX_DEADLINE_NEUTRALIZATION_CHANGED');
        }
      }
      // Legacy-Submissions besaßen teils nur den Rücklink
      // request.form_submission_id. Vor dem Delete wird deterministisch eine
      // der gelöschten UUIDs als Tombstone übernommen; ein schon vorhandener
      // expliziter request_id bleibt unverändert.
      await tx.$queryRaw(
        Prisma.sql`
          WITH purged_form_links AS (
            SELECT "form_submission_id",
                   min("id"::text)::uuid AS "request_id"
              FROM "request"
             WHERE "id" IN (${Prisma.join(eligibleIds.map((id) => Prisma.sql`${id}::uuid`))})
               AND "form_submission_id" IS NOT NULL
             GROUP BY "form_submission_id"
          )
          UPDATE "form_submission" AS submission
             SET "request_id" = links."request_id"
            FROM purged_form_links AS links
           WHERE submission."id" = links."form_submission_id"
             AND submission."request_id" IS NULL
          RETURNING submission."id"
        `,
      );
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
      const taxDeadlineNotificationHistory =
        await prismaOwner.taxDeadlineNotificationHistory.deleteMany({
          // TAX-DEADLINE-AUTOREQUEST-001: Der beim Rematerialisieren bewusst
          // pseudonym gehaltene technische Versandnachweis ist kein
          // Dauerarchiv. Maximal ein Jahr nach archivedAt wird er strikt
          // tenantgebunden entfernt.
          where: { tenantId, archivedAt: { lt: notifCutoff } },
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
        taxDeadlineNotificationHistoryDeleted: taxDeadlineNotificationHistory.count,
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
              taxDeadlineNotificationHistoryCutoff: notifCutoff.toISOString(),
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
          taxDeadlineNotificationHistoryCutoff: notifCutoff.toISOString(),
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
