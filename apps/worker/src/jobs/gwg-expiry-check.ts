// =============================================================================
// gwg-expiry-check-Worker
//
// Dreistufige Eskalation von ablaufenden GwG-Checks + Personalausweis-Ablauf-
// Check. Idempotent (eine Notification pro Empfänger und Stufe).
//
// GwG-Check-Stufen (gemessen an `validUntil`):
//   - 90 Tage vor Ablauf:  Stufe 1 — Bearbeiter (HAUPTBEARBEITER) informieren
//   - 30 Tage vor Ablauf:  Stufe 2 — zusätzlich Berufsträger informieren
//   - Bei/nach Ablauf:     Stufe 3 — alle ADMIN/PARTNER + Mandant deaktivieren
//
// Empfänger (F-10, ACCESS-NOTIFICATION-RECIPIENT-001): Zuständige zählen nur,
// solange sie aktiv sind und den Mandanten aktuell sehen dürfen; bleibt niemand,
// gehen Stufe 1/2 und Ausweis-Hinweise an die aktiven ADMIN/PARTNER
// (notification-recipients.ts, gemeinsam mit poa-expiry-check).
//
// ID-Document-Ablauf:
//   - 60 Tage vor expiry_date: Auto-Anforderung an Mandant erzeugen
//     („Bitte neuen Personalausweis hochladen") + Notification an Bearbeiter
//   - Nur einmal pro Dokument (idempotent über offene Request)
//
// GwG-Lösch-Queue (§ 8 Abs. 1 und 4, DSGVO Art. 5 Abs. 1 lit. e):
//   - Sobald Belege/Aufzeichnungen beendeter Mandate löschreif sind, geht
//     täglich eine idempotente Notification (GWG_DELETION_DUE) an alle
//     ADMIN/PARTNER — die Review-Queue (/staff/admin/gwg-retention) war
//     vorher rein passiv. Tages-Dedupe über resource_id = Tenant-ID.
// =============================================================================

import { createWorker } from '../worker-factory';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { type NotificationKind } from '@prisma/client';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { advanceSessionRevocation } from '@taxtronik/crypto';
import { dueGwgCheckDeletionsWhere, dueGwgDeletionDocsWhere } from '@taxtronik/tax';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { notify } from '../notify';
import { resolveClientWarningRecipientsTx } from '../notification-recipients';
import { berlinTodayUtcMidnight, wholeDaysBetween } from '../date-util';

// RF-8: record() braucht nur den Tx (der TimestampPort dient dem Versiegeln,
// nicht dem Schreiben) — gleiches Muster wie risk-analyse-llm.ts.
const evidence = new EvidenceService(new LocalTimestampAdapter());

const WARN_DAYS_STAGE1 = 90;
const WARN_DAYS_STAGE2 = 30;
const ID_DOC_WARN_DAYS = 60;

type Stage = 'STAGE1' | 'STAGE2' | 'STAGE3';

const NOTIFICATION_KIND_FOR_STAGE: Record<Stage, NotificationKind> = {
  STAGE1: 'GWG_EXPIRY_90D',
  STAGE2: 'GWG_EXPIRY_30D',
  STAGE3: 'GWG_EXPIRED',
};

async function resolveObsoleteStageNotifications(
  tenantId: string,
  checkId: string,
  stage: Stage,
): Promise<void> {
  if (stage !== 'STAGE2') return;
  await withWorkerTenantContext(tenantId, (tx) =>
    resolveNotificationsTx(tx, {
      tenantId,
      resources: [{ resourceType: 'gwg_check', resourceId: checkId }],
      kinds: ['GWG_EXPIRY_SOON', 'GWG_EXPIRY_90D'],
    }),
  );
}

async function resolveIdDocumentWarning(
  tenantId: string,
  documentId: string,
  expired: boolean,
): Promise<void> {
  if (!expired) return;
  await withWorkerTenantContext(tenantId, (tx) =>
    resolveNotificationsTx(tx, {
      tenantId,
      resources: [{ resourceType: 'gwg_id_document', resourceId: documentId }],
      kinds: ['GWG_ID_EXPIRY_SOON'],
    }),
  );
}

/** Fachlicher DATE-Status; Ablaufdatum selbst ist noch ein gültiger Tag. */
export function idDocumentExpiryTitleSuffix(daysLeft: number): string {
  if (daysLeft < 0) return `seit ${-daysLeft} Tagen abgelaufen`;
  if (daysLeft === 0) return 'läuft heute ab';
  return `läuft in ${daysLeft} Tagen ab`;
}

async function processExpiringIdDocuments(
  tenantId: string,
  now: Date,
  systemStaff: { id: string },
): Promise<{ idDocReminders: number; idDocRequests: number }> {
  let idDocReminders = 0;
  let idDocRequests = 0;
  const berlinToday = berlinTodayUtcMidnight(now);
  const idDocCutoff = new Date(berlinToday.getTime() + ID_DOC_WARN_DAYS * 24 * 60 * 60 * 1000);
  const expiringDocs = await prismaOwner.gwgIdDocument.findMany({
    where: {
      expiryDate: { not: null, lte: idDocCutoff },
      check: {
        tenantId,
        status: { in: ['VERIFIED', 'IN_REVIEW'] },
      },
    },
    include: {
      check: {
        select: {
          clientId: true,
          client: {
            select: {
              name: true,
              allowActive: true,
              responsibilities: {
                where: { role: { in: ['HAUPTBEARBEITER', 'BERUFSTRAEGER'] } },
                select: { staffId: true },
              },
            },
          },
        },
      },
    },
  });

  const existingIdDocRequests = expiringDocs.length
    ? await prismaOwner.request.findMany({
        where: {
          tenantId,
          status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
          linkedGwgIdDocumentId: { in: expiringDocs.map((doc) => doc.id) },
        },
        select: { linkedGwgIdDocumentId: true },
      })
    : [];
  const requestedIdDocumentIds = new Set(
    existingIdDocRequests.flatMap((request) =>
      request.linkedGwgIdDocumentId ? [request.linkedGwgIdDocumentId] : [],
    ),
  );

  for (const doc of expiringDocs) {
    if (!doc.expiryDate) continue;
    // expiry_date ist ein fachliches DATE und gilt einschließlich seines
    // Berliner Kalendertags. Ein Ausweis mit Ablaufdatum heute ist daher
    // noch nicht abgelaufen, unabhängig von UTC-Uhrzeit und Sommerzeit.
    const daysLeft = wholeDaysBetween(berlinToday, doc.expiryDate);
    const isExpired = daysLeft < 0;

    const titleSuffix = idDocumentExpiryTitleSuffix(daysLeft);
    await resolveIdDocumentWarning(tenantId, doc.id, isExpired);
    const expiryDate = doc.expiryDate;
    // Notification an aktive, berechtigte Bearbeiter; sonst ADMIN/PARTNER
    // (F-10). R-11: Empfänger und Hinweise in derselben Tenant-Transaktion.
    const recipients = await withWorkerTenantContext(tenantId, async (tx) => {
      const staffIds = await resolveClientWarningRecipientsTx(tx, {
        tenantId,
        clientId: doc.check.clientId,
        staffIds: doc.check.client.responsibilities.map((r) => r.staffId),
      });
      await notify(
        tx,
        staffIds.map((staffId) => ({
          tenantId,
          staffId,
          kind: (isExpired ? 'GWG_ID_EXPIRED' : 'GWG_ID_EXPIRY_SOON') as NotificationKind,
          title: `Ausweis von ${doc.ownerName} ${titleSuffix} — ${doc.check.client.name}`,
          body: `${idDocTypeLabel(doc.type)}, gültig bis ${dateFmt(expiryDate)}.`,
          href: `/staff/clients/${doc.check.clientId}/gwg`,
          resourceType: 'gwg_id_document',
          resourceId: doc.id,
        })),
      );
      return staffIds;
    });
    idDocReminders += recipients.length;

    // Auto-Anforderung an Mandant — U-5: exakter Idempotenz-Match per FK
    // statt Titel-Substring. Vorher: zwei BeneficialOwners „Müller" und
    // „Müller-Schmidt" teilten den `contains: ownerName`-Match — der
    // zweite Auto-Request wurde nie angelegt.
    if (!requestedIdDocumentIds.has(doc.id) && doc.check.client.allowActive) {
      const created = await prismaOwner.request.createMany({
        data: [
          {
            tenantId,
            clientId: doc.check.clientId,
            title: `Neuer ${idDocTypeLabel(doc.type)} von ${doc.ownerName} erforderlich`,
            description: `Der ${idDocTypeLabel(doc.type)} läuft am ${dateFmt(
              doc.expiryDate,
            )} ab. Bitte stellen Sie eine aktuelle Kopie (Vorder- und Rückseite) zur Verfügung.`,
            priority: isExpired ? 'HIGH' : 'NORMAL',
            createdByStaff: systemStaff.id,
            dueAt: isExpired ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) : doc.expiryDate,
            linkedGwgIdDocumentId: doc.id,
          },
        ],
        skipDuplicates: true,
      });
      requestedIdDocumentIds.add(doc.id);
      idDocRequests += created.count;
    }
  }

  return { idDocReminders, idDocRequests };
}

export const gwgExpiryWorker = createWorker<ChecksJob>(
  JOB_QUEUES.gwgExpiry.name,
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    let stage1 = 0;
    let stage2 = 0;
    let stage3 = 0;
    let idDocReminders = 0;
    let idDocRequests = 0;
    let deletionDueNotices = 0;
    let portalRevocationFailures = 0;

    for (const tenantId of tenantIds) {
      const now = new Date();

      // System-Staff für Auto-Anforderungen + Empfänger der Lösch-Queue. Den
      // Fallback mandantenbezogener Hinweise löst resolveClientWarningRecipientsTx
      // je Mandant mit aktuellem Zugriffsstand auf.
      const adminPartners = await prismaOwner.staffUser.findMany({
        where: {
          tenantId,
          active: true,
          roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
        },
        select: { id: true },
      });
      if (adminPartners.length === 0) {
        log.info({ tenantId }, 'gwg-expiry: keine Admin/Partner — skip');
        continue;
      }
      const systemStaff = adminPartners[0]!;

      // ----------------------------------------------------------------------
      // 1. GwG-Check-Eskalation
      // ----------------------------------------------------------------------
      // RF-14: nur das Relevanz-Fenster laden (validUntil <= now + 90 Tage =
      // Stage-1-Grenze). Vorher zog die Query ALLE VERIFIED-Checks mit
      // validUntil und filterte erst im Speicher — unnötige Last, die mit dem
      // Mandantenbestand linear wächst.
      const stage1Cutoff = new Date(now.getTime() + WARN_DAYS_STAGE1 * 24 * 60 * 60 * 1000);
      const candidates = await prismaOwner.gwgCheck.findMany({
        where: {
          tenantId,
          status: 'VERIFIED',
          validUntil: { not: null, lte: stage1Cutoff },
        },
        include: {
          client: {
            select: {
              id: true,
              name: true,
              responsibilities: {
                where: { role: { in: ['HAUPTBEARBEITER', 'BERUFSTRAEGER'] } },
                select: { staffId: true, role: true },
              },
            },
          },
        },
      });

      for (const check of candidates) {
        const due = check.validUntil!.getTime();
        const daysLeft = Math.ceil((due - now.getTime()) / (24 * 60 * 60 * 1000));
        const stage = stageForDaysLeft(daysLeft);
        if (!stage) continue;

        const kind = NOTIFICATION_KIND_FOR_STAGE[stage];

        if (stage === 'STAGE3') {
          // Mandant deaktivieren + Check auf EXPIRED. RF-8: läuft jetzt im
          // Tenant-Context und schreibt die System-Statuswechsel in die
          // Audit-Chain (vorher: nackte prismaOwner-Updates ohne
          // evidence.record) — Muster analog risk-analyse-llm.ts.
          let clientDeactivated = false;
          let supersededByValid = false;
          await withWorkerTenantContext(tenantId, async (tx) => {
            const clientBefore = await tx.client.findUnique({
              where: { id: check.clientId },
              select: { allowActive: true },
            });
            const checkRes = await tx.gwgCheck.updateMany({
              where: { id: check.id, status: 'VERIFIED' },
              data: { status: 'EXPIRED' },
            });
            if (checkRes.count === 0) return;
            if (checkRes.count > 0) {
              await evidence.record(tx, {
                tenantId,
                actorType: 'SYSTEM',
                actorId: null,
                action: 'gwg.check.expire',
                resourceType: 'gwg_check',
                resourceId: check.id,
                before: { status: 'VERIFIED' },
                after: { status: 'EXPIRED', validUntil: check.validUntil },
              });
            }
            // Existiert für denselben Mandanten ein NEUERER, noch gültiger
            // VERIFIED-Check (Wiederholungsprüfung)? openCheckAction/
            // verifyCheckAction lösen alte Checks nicht ab, sodass mehrere
            // VERIFIED-Checks koexistieren. Dann darf der abgelaufene Alt-Check
            // den Mandanten NICHT deaktivieren. Der eben auf EXPIRED gesetzte
            // Check ist hier bereits ausgeschlossen (status = VERIFIED).
            const stillValid = await tx.gwgCheck.findFirst({
              where: { clientId: check.clientId, status: 'VERIFIED', validUntil: { gt: now } },
              select: { id: true },
            });
            if (stillValid) {
              supersededByValid = true;
              await resolveNotificationsTx(tx, {
                tenantId,
                resources: [{ resourceType: 'gwg_check', resourceId: check.id }],
              });
              return;
            }
            const clientRes = await tx.client.updateMany({
              where: { id: check.clientId, allowActive: true },
              data: { allowActive: false },
            });
            const clientAfter = await tx.client.findUnique({
              where: { id: check.clientId },
              select: { allowActive: true },
            });
            if (clientBefore?.allowActive === true && clientAfter?.allowActive === false) {
              clientDeactivated = true;
              await evidence.record(tx, {
                tenantId,
                actorType: 'SYSTEM',
                actorId: null,
                action: 'client.deactivate.gwg_expired',
                resourceType: 'client',
                resourceId: check.clientId,
                before: { allowActive: true },
                after: {
                  allowActive: false,
                  gwgCheckId: check.id,
                  deactivatedByDbTrigger: clientRes.count === 0,
                },
              });
            }
            await resolveNotificationsTx(tx, {
              tenantId,
              resources: [{ resourceType: 'gwg_check', resourceId: check.id }],
              kinds: ['GWG_EXPIRY_SOON', 'GWG_EXPIRY_90D', 'GWG_EXPIRY_30D'],
            });
          });
          // Durch einen gültigen neueren Check abgelöst: nur Housekeeping
          // (Alt-Check EXPIRED), keine Deaktivierung und keine Eskalations-
          // Notification — es besteht kein Handlungsbedarf.
          if (supersededByValid) {
            continue;
          }
          // GwG-Schranke (§ 11 GwG): bestehende Portal-Sessions aller Kontakte
          // sofort beenden — sonst bliebe ein eingeloggter Kontakt bis zum
          // JWT-Ablauf (24 h) handlungsfähig. Nach dem Commit (Redis ist nicht
          // transaktional); nur beim tatsächlichen Übergang (idempotent, der
          // Check ist danach EXPIRED und kein Kandidat mehr).
          if (clientDeactivated) {
            const contacts = await prismaOwner.clientContact.findMany({
              where: { clientId: check.clientId, active: true },
              select: { id: true },
            });
            portalRevocationFailures += await revokePortalSessions(contacts.map((c) => c.id));
          }
        }

        await resolveObsoleteStageNotifications(tenantId, check.id, stage);

        // F-10: erst nach dem Statuswechsel und auf dem dann aktuellen Stand;
        // R-11: Empfänger und Hinweise in derselben Tenant-Transaktion.
        const title = titleForStage(stage, daysLeft, check.client.name);
        const body = bodyForStage(stage, check.riskLevel ?? null);
        const recipients = await withWorkerTenantContext(tenantId, async (tx) => {
          const staffIds = await resolveClientWarningRecipientsTx(tx, {
            tenantId,
            clientId: check.clientId,
            staffIds: responsibleStaffForStage(stage, check.client.responsibilities),
            includeAdminPartners: stage === 'STAGE3',
          });
          await notify(
            tx,
            staffIds.map((staffId) => ({
              tenantId,
              staffId,
              kind,
              title,
              body,
              href: `/staff/clients/${check.clientId}/gwg`,
              resourceType: 'gwg_check',
              resourceId: check.id,
            })),
          );
          return staffIds;
        });
        if (stage === 'STAGE1') stage1 += recipients.length;
        if (stage === 'STAGE2') stage2 += recipients.length;
        if (stage === 'STAGE3') stage3 += recipients.length;
      }

      // ----------------------------------------------------------------------
      // 2. Personalausweis-Ablauf
      // ----------------------------------------------------------------------
      const idDocuments = await processExpiringIdDocuments(tenantId, now, systemStaff);
      idDocReminders += idDocuments.idDocReminders;
      idDocRequests += idDocuments.idDocRequests;

      // ----------------------------------------------------------------------
      // 3. GwG-Lösch-Queue (§ 8 Abs. 1 und 4, DSGVO-Speicherbegrenzung) — tägliche Notification an
      //    ADMIN/PARTNER, sobald Einträge löschreif sind.
      //
      //    Fristlogik und Filter gemeinsam mit der Web-Review-Queue
      //    (R-02, @taxtronik/tax): fünf Jahre ab Mandatsende bzw. Feststellung
      //    bei nie zustande gekommener Beziehung. Auch die Höchstfrist beginnt
      //    erst an diesem fachlichen Startpunkt; das bloße Belegalter beendet
      //    keine laufende Geschäftsbeziehung.
      // ----------------------------------------------------------------------
      const [dueDocs, dueChecks] = await Promise.all([
        prismaOwner.document.count({ where: { tenantId, ...dueGwgDeletionDocsWhere(now) } }),
        prismaOwner.gwgCheck.count({ where: { tenantId, ...dueGwgCheckDeletionsWhere(now) } }),
      ]);
      const dueTotal = dueDocs + dueChecks;
      if (dueTotal > 0) {
        const itemWord = dueTotal === 1 ? '1 Eintrag' : `${dueTotal} Einträge`;
        // Idempotent: ungelesene Notification wird aktualisiert; der Daily-
        // Dedupe-Index (iter81) deckelt zusätzlich auf 1/Tag. resource_id =
        // Tenant-ID als stabiler Schlüssel für den Tages-Dedupe.
        await withWorkerTenantContext(tenantId, (tx) =>
          notify(
            tx,
            adminPartners.map((s) => ({
              tenantId,
              staffId: s.id,
              kind: 'GWG_DELETION_DUE' as NotificationKind,
              title: `GwG-Löschprüfung: ${itemWord} löschreif`,
              body:
                'Belege/Aufzeichnungen beendeter Mandate oder nie zustande gekommener Beziehungen, ' +
                'deren Aufbewahrungsfrist (§ 8 Abs. 4 GwG) abgelaufen ist — bitte Vernichtung in der Review-Queue bestätigen.',
              href: '/staff/admin/gwg-retention',
              resourceType: 'tenant',
              resourceId: tenantId,
            })),
          ),
        );
        deletionDueNotices += adminPartners.length;
      } else {
        await withWorkerTenantContext(tenantId, (tx) =>
          resolveNotificationsTx(tx, {
            tenantId,
            resources: [{ resourceType: 'tenant', resourceId: tenantId }],
            kinds: ['GWG_DELETION_DUE'],
          }),
        );
      }
    }

    log.info(
      { stage1, stage2, stage3, idDocReminders, idDocRequests, deletionDueNotices },
      'gwg-expiry: done',
    );
    // Fail-closed (R-02): Ein nicht bestätigter Widerruf darf den Lauf nicht als
    // erfolgreich abschließen. Alle Tenants sind zu diesem Zeitpunkt bearbeitet;
    // der Fehler macht den Lauf in Queue-Status und Logs sichtbar.
    if (portalRevocationFailures > 0) {
      throw new Error(
        `gwg-expiry: ${portalRevocationFailures} Portal-Session-Widerruf(e) nicht bestätigt`,
      );
    }
    return { stage1, stage2, stage3, idDocReminders, idDocRequests, deletionDueNotices };
  },
  { connection, concurrency: 1 },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Portal-Session-Widerruf (S11) — derselbe Kern wie die Web-App
// (`advanceSessionRevocation` aus @taxtronik/crypto, R-02): Key-Schema
// `revoke:portal:<contactId>`, monotones Lua-Skript (ein älterer Zeitstempel
// schiebt den Cutoff nie zurück, ACCESS-TENANT-RLS-001) und fail-closed. Der
// Worker schreibt über seine BullMQ-Redis-Verbindung (gleiche REDIS_URL, kein
// Key-Prefix). Vorher: eigene Kopie per `SET … EX`, Fehler nur geloggt.
//
// Ein Fehlschlag wird gezählt und lässt den Lauf nach allen Tenants
// fehlschlagen. Die Deaktivierung bleibt committed: Der Session-Callback in
// apps/web/src/server/auth/portal.ts prüft client.allowActive zusätzlich bei
// jedem Request (Defense in Depth).
async function revokePortalSessions(contactIds: string[]): Promise<number> {
  let failed = 0;
  for (const contactId of contactIds) {
    try {
      await advanceSessionRevocation(connection, 'portal', contactId);
    } catch (e) {
      failed += 1;
      const cause = (e as Error).cause as Error | undefined;
      log.error(
        { contactId, err: (cause ?? (e as Error)).message },
        'gwg-expiry: Portal-Session-Widerruf nicht bestätigt (fail-closed)',
      );
    }
  }
  return failed;
}

function stageForDaysLeft(daysLeft: number): Stage | null {
  if (daysLeft <= 0) return 'STAGE3';
  if (daysLeft <= WARN_DAYS_STAGE2) return 'STAGE2';
  if (daysLeft <= WARN_DAYS_STAGE1) return 'STAGE1';
  return null;
}

/**
 * Zuständige je Stufe (GWG-REVERIFICATION-VALIDITY-001): Stufe 1 nur
 * Hauptbearbeiter, ab Stufe 2 zusätzlich Berufsträger. Aktivität, Zugriff und
 * der ADMIN/PARTNER-Fallback bzw. (Stufe 3) die ADMIN/PARTNER-Eskalation folgen
 * in resolveClientWarningRecipientsTx.
 */
function responsibleStaffForStage(
  stage: Stage,
  responsibilities: Array<{ staffId: string; role: string }>,
): string[] {
  const bearbeiter = responsibilities
    .filter((r) => r.role === 'HAUPTBEARBEITER')
    .map((r) => r.staffId);
  if (stage === 'STAGE1') return bearbeiter;
  const berufstraeger = responsibilities
    .filter((r) => r.role === 'BERUFSTRAEGER')
    .map((r) => r.staffId);
  return [...bearbeiter, ...berufstraeger];
}

function titleForStage(stage: Stage, daysLeft: number, clientName: string): string {
  if (stage === 'STAGE3') {
    return `GwG-Prüfung abgelaufen — ${clientName} deaktiviert`;
  }
  return `GwG-Prüfung läuft in ${daysLeft} Tagen ab — ${clientName}`;
}

function bodyForStage(stage: Stage, risk: string | null): string {
  if (stage === 'STAGE3') {
    return 'Mandant kann keine neuen Vorgänge mehr starten. Bitte erneute Identifizierung anstoßen.';
  }
  const riskNote = risk ? ` Risiko: ${risk}.` : '';
  if (stage === 'STAGE2')
    return `Wiederholungsprüfung erforderlich — letzte Eskalationsstufe vor Ablauf.${riskNote}`;
  return `Wiederholungsprüfung in den nächsten 90 Tagen einplanen.${riskNote}`;
}

function idDocTypeLabel(type: string): string {
  const m: Record<string, string> = {
    PERSONALAUSWEIS: 'Personalausweis',
    REISEPASS: 'Reisepass',
    HANDELSREGISTERAUSZUG: 'HR-Auszug',
    GESELLSCHAFTSVERTRAG: 'Gesellschaftsvertrag',
    VOLLMACHT: 'Vollmacht',
    TRANSPARENZREGISTER_AUSZUG: 'Transparenzregister-Auszug',
    SONSTIGES: 'Identifizierungsdokument',
  };
  return m[type] ?? type;
}

function dateFmt(d: Date): string {
  return new Intl.DateTimeFormat('de-DE').format(d);
}
