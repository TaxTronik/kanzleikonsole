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

import { Worker } from 'bullmq';
import { type NotificationKind } from '@prisma/client';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { upsertNotification } from '../notify';

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

export const gwgExpiryWorker = new Worker<ChecksJob>(
  'gwg-expiry-check',
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

    for (const tenantId of tenantIds) {
      const now = new Date();

      // System-Staff für Auto-Anforderungen + Fallback-Empfänger
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

        const recipients = recipientsForStage(stage, check.client.responsibilities, adminPartners);
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
            await revokePortalSessions(contacts.map((c) => c.id));
          }
        }

        await resolveObsoleteStageNotifications(tenantId, check.id, stage);

        const title = titleForStage(stage, daysLeft, check.client.name);
        const body = bodyForStage(stage, check.riskLevel ?? null);
        for (const staffId of recipients) {
          await upsertNotification(tenantId, staffId, {
            kind,
            title,
            body,
            href: `/staff/clients/${check.clientId}/gwg`,
            resourceType: 'gwg_check',
            resourceId: check.id,
          });
        }
        if (stage === 'STAGE1') stage1 += recipients.length;
        if (stage === 'STAGE2') stage2 += recipients.length;
        if (stage === 'STAGE3') stage3 += recipients.length;
      }

      // ----------------------------------------------------------------------
      // 2. Personalausweis-Ablauf
      // ----------------------------------------------------------------------
      const idDocCutoff = new Date(now.getTime() + ID_DOC_WARN_DAYS * 24 * 60 * 60 * 1000);
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
        const expiryMs = doc.expiryDate.getTime();
        const daysLeft = Math.ceil((expiryMs - now.getTime()) / (24 * 60 * 60 * 1000));
        const isExpired = daysLeft <= 0;

        // Notification an Bearbeiter (auch ADMIN/PARTNER als Fallback)
        const respIds = doc.check.client.responsibilities.map((r) => r.staffId);
        const recipients = respIds.length > 0 ? respIds : adminPartners.map((s) => s.id);
        const titleSuffix = isExpired
          ? `seit ${-daysLeft} Tagen abgelaufen`
          : `läuft in ${daysLeft} Tagen ab`;
        await resolveIdDocumentWarning(tenantId, doc.id, isExpired);
        for (const staffId of recipients) {
          await upsertNotification(tenantId, staffId, {
            kind: (isExpired ? 'GWG_ID_EXPIRED' : 'GWG_ID_EXPIRY_SOON') as NotificationKind,
            title: `Ausweis von ${doc.ownerName} ${titleSuffix} — ${doc.check.client.name}`,
            body: `${idDocTypeLabel(doc.type)}, gültig bis ${dateFmt(doc.expiryDate)}.`,
            href: `/staff/clients/${doc.check.clientId}/gwg`,
            resourceType: 'gwg_id_document',
            resourceId: doc.id,
          });
        }
        idDocReminders += recipients.length;

        // Auto-Anforderung an Mandant — U-5: exakter Idempotenz-Match per FK
        // statt Titel-Substring. Vorher: zwei BeneficialOwners „Müller" und
        // „Müller-Schmidt" teilten den `contains: ownerName`-Match — der
        // zweite Auto-Request wurde nie angelegt.
        if (!requestedIdDocumentIds.has(doc.id) && doc.check.client.allowActive) {
          await prismaOwner.request.create({
            data: {
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
          });
          requestedIdDocumentIds.add(doc.id);
          idDocRequests += 1;
        }
      }

      // ----------------------------------------------------------------------
      // 3. GwG-Lösch-Queue (§ 8 Abs. 1 und 4, DSGVO-Speicherbegrenzung) — tägliche Notification an
      //    ADMIN/PARTNER, sobald Einträge löschreif sind.
      //
      //    Fristlogik wie apps/web/src/server/gwg/retention.ts: Frist endet am
      //    Jahresende des Mandatsende-Jahres + 5 Jahre → „löschreif" ⟺
      //    mandateEndedAt < 1.1.(Jahr(now) − 5). Der SQL-Filter ist hier EXAKT
      //    (kein Grobfilter): jedes Mandatsende vor diesem Stichtag hat eine
      //    Frist ≤ 1.1.(Jahr(now)) ≤ now; jedes spätere eine Frist > now.
      // ----------------------------------------------------------------------
      const gwgDeletionCutoff = new Date(Date.UTC(now.getUTCFullYear() - 5, 0, 1));
      const [dueDocs, dueChecks] = await Promise.all([
        prismaOwner.document.count({
          where: {
            tenantId,
            classification: 'GWG_EVIDENCE',
            deletedAt: null,
            OR: [
              { client: { mandateEndedAt: { lt: gwgDeletionCutoff } } },
              {
                createdAt: { lt: gwgDeletionCutoff },
                client: { mandateEndedAt: null },
                gwgOnboardingInvite: {
                  is: {
                    OR: [
                      { status: { in: ['CANCELLED', 'EXPIRED'] } },
                      { status: { in: ['PENDING', 'STARTED'] }, expiresAt: { lte: now } },
                      {
                        status: 'SUBMITTED',
                        gwgCheck: {
                          is: {
                            OR: [{ status: 'REJECTED' }, { status: 'EXPIRED', verifiedAt: null }],
                          },
                        },
                      },
                    ],
                  },
                },
              },
              {
                createdAt: { lt: gwgDeletionCutoff },
                client: { mandateEndedAt: null },
                gwgIdDocuments: {
                  some: {
                    check: {
                      OR: [{ status: 'REJECTED' }, { status: 'EXPIRED', verifiedAt: null }],
                    },
                  },
                },
              },
            ],
          },
        }),
        prismaOwner.gwgCheck.count({
          where: {
            tenantId,
            destroyedAt: null,
            OR: [
              { client: { mandateEndedAt: { lt: gwgDeletionCutoff } } },
              {
                client: { mandateEndedAt: null },
                updatedAt: { lt: gwgDeletionCutoff },
                idDocuments: { none: { createdAt: { gte: gwgDeletionCutoff } } },
                beneficialOwners: { none: { createdAt: { gte: gwgDeletionCutoff } } },
                OR: [{ status: 'REJECTED' }, { status: 'EXPIRED', verifiedAt: null }],
              },
            ],
          },
        }),
      ]);
      const dueTotal = dueDocs + dueChecks;
      if (dueTotal > 0) {
        const itemWord = dueTotal === 1 ? '1 Eintrag' : `${dueTotal} Einträge`;
        for (const s of adminPartners) {
          // Idempotent: ungelesene Notification wird aktualisiert; der Daily-
          // Dedupe-Index (iter81) deckelt zusätzlich auf 1/Tag. resource_id =
          // Tenant-ID als stabiler Schlüssel für den Tages-Dedupe.
          await upsertNotification(tenantId, s.id, {
            kind: 'GWG_DELETION_DUE' as NotificationKind,
            title: `GwG-Löschprüfung: ${itemWord} löschreif`,
            body:
              'Belege/Aufzeichnungen beendeter Mandate, deren Aufbewahrungsfrist ' +
              '(§ 8 Abs. 4 GwG) abgelaufen ist — bitte Vernichtung in der Review-Queue bestätigen.',
            href: '/staff/admin/gwg-retention',
            resourceType: 'tenant',
            resourceId: tenantId,
          });
        }
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
    return { stage1, stage2, stage3, idDocReminders, idDocRequests, deletionDueNotices };
  },
  { connection, concurrency: 1 },
);

gwgExpiryWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'gwg-expiry: failed');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Portal-Session-Revocation (S11) — Worker-Seite.
//
// KOPPLUNG: Key-Schema und Semantik stammen aus
// apps/web/src/server/auth/revocation.ts — `revoke:portal:<contactId>` →
// ms-Timestamp; Tokens mit `iat` davor gelten als revoked; TTL 30 Tage
// (länger als die 24-h-JWT-TTL, damit auch noch nicht abgelaufene Tokens
// erfasst werden). Das Web-Modul ist nicht importierbar (`@/`-Alias,
// Web-Logger/Singleton) — der Worker schreibt deshalb über seine bestehende
// BullMQ-Redis-Verbindung (gleiche REDIS_URL, kein Key-Prefix) dieselben
// Keys. Schema-Änderungen in revocation.ts MÜSSEN hier nachgezogen werden.
//
// Fail-Mode: fail-open mit Log (analog revocation.ts) — der Session-Callback
// in apps/web/src/server/auth/portal.ts prüft client.allowActive zusätzlich
// bei jedem Request (Defense in Depth).
const PORTAL_REVOKE_TTL_SEC = 30 * 24 * 60 * 60;

async function revokePortalSessions(contactIds: string[]): Promise<void> {
  for (const contactId of contactIds) {
    try {
      await connection.set(
        `revoke:portal:${contactId}`,
        String(Date.now()),
        'EX',
        PORTAL_REVOKE_TTL_SEC,
      );
    } catch (e) {
      log.warn(
        { contactId, err: (e as Error).message },
        'gwg-expiry: Portal-Session-Revocation fehlgeschlagen (fail-open)',
      );
    }
  }
}

function stageForDaysLeft(daysLeft: number): Stage | null {
  if (daysLeft <= 0) return 'STAGE3';
  if (daysLeft <= WARN_DAYS_STAGE2) return 'STAGE2';
  if (daysLeft <= WARN_DAYS_STAGE1) return 'STAGE1';
  return null;
}

function recipientsForStage(
  stage: Stage,
  responsibilities: Array<{ staffId: string; role: string }>,
  adminPartners: Array<{ id: string }>,
): string[] {
  const bearbeiter = responsibilities
    .filter((r) => r.role === 'HAUPTBEARBEITER')
    .map((r) => r.staffId);
  const berufstraeger = responsibilities
    .filter((r) => r.role === 'BERUFSTRAEGER')
    .map((r) => r.staffId);

  let ids: string[];
  if (stage === 'STAGE1') {
    ids = bearbeiter.length > 0 ? bearbeiter : adminPartners.map((s) => s.id);
  } else if (stage === 'STAGE2') {
    const combined = [...bearbeiter, ...berufstraeger];
    ids = combined.length > 0 ? combined : adminPartners.map((s) => s.id);
  } else {
    // STAGE3 — alle relevanten Adressaten
    const combined = [...bearbeiter, ...berufstraeger, ...adminPartners.map((s) => s.id)];
    ids = combined;
  }
  return Array.from(new Set(ids));
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
