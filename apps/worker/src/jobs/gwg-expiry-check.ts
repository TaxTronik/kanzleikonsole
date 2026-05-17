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
// =============================================================================

import { Worker } from 'bullmq';
import { Prisma, type NotificationKind } from '@prisma/client';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';


const WARN_DAYS_STAGE1 = 90;
const WARN_DAYS_STAGE2 = 30;
const ID_DOC_WARN_DAYS = 60;

type Stage = 'STAGE1' | 'STAGE2' | 'STAGE3';

const NOTIFICATION_KIND_FOR_STAGE: Record<Stage, NotificationKind> = {
  STAGE1: 'GWG_EXPIRY_90D',
  STAGE2: 'GWG_EXPIRY_30D',
  STAGE3: 'GWG_EXPIRED',
};

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
      const candidates = await prismaOwner.gwgCheck.findMany({
        where: {
          tenantId,
          status: 'VERIFIED',
          validUntil: { not: null },
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
          // Mandant deaktivieren + Check auf EXPIRED
          await prismaOwner.$transaction([
            prismaOwner.gwgCheck.updateMany({
              where: { id: check.id, status: 'VERIFIED' },
              data: { status: 'EXPIRED' },
            }),
            prismaOwner.client.updateMany({
              where: { id: check.clientId, allowActive: true },
              data: { allowActive: false },
            }),
          ]);
        }

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

      for (const doc of expiringDocs) {
        if (!doc.expiryDate) continue;
        const expiryMs = doc.expiryDate.getTime();
        const daysLeft = Math.ceil((expiryMs - now.getTime()) / (24 * 60 * 60 * 1000));
        const isExpired = daysLeft <= 0;

        // Notification an Bearbeiter (auch ADMIN/PARTNER als Fallback)
        const respIds = doc.check.client.responsibilities.map((r) => r.staffId);
        const recipients =
          respIds.length > 0 ? respIds : adminPartners.map((s) => s.id);
        const titleSuffix = isExpired
          ? `seit ${-daysLeft} Tagen abgelaufen`
          : `läuft in ${daysLeft} Tagen ab`;
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
        const existingRequest = await prismaOwner.request.findFirst({
          where: {
            tenantId,
            clientId: doc.check.clientId,
            status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
            linkedGwgIdDocumentId: doc.id,
          },
        });
        if (!existingRequest && doc.check.client.allowActive) {
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
          idDocRequests += 1;
        }
      }
    }

    log.info(
      { stage1, stage2, stage3, idDocReminders, idDocRequests },
      'gwg-expiry: done',
    );
    return { stage1, stage2, stage3, idDocReminders, idDocRequests };
  },
  { connection, concurrency: 1 },
);

gwgExpiryWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'gwg-expiry: failed');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const bearbeiter = responsibilities.filter((r) => r.role === 'HAUPTBEARBEITER').map((r) => r.staffId);
  const berufstraeger = responsibilities.filter((r) => r.role === 'BERUFSTRAEGER').map((r) => r.staffId);

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
  if (stage === 'STAGE2') return `Wiederholungsprüfung erforderlich — letzte Eskalationsstufe vor Ablauf.${riskNote}`;
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

// U-1: Notify-Helper läuft jetzt in einer withWorkerTenantContext-Transaktion.
// Vorher: findFirst-then-create auf prismaOwner ohne TX → Race bei parallelen
// Triggern (Scheduler-Tick + manueller Admin-Trigger) + kein RLS-/Audit-Context.
// Wir machen die Find/Update/Create-Folge atomar pro Tenant; bei P2002 vom
// Daily-Dedupe-Index (falls Kind dort gelistet) interpretieren wir das als
// „heute bereits geschrieben". Symmetrisch zum Q-2/P-8-Pattern.
async function upsertNotification(
  tenantId: string,
  staffId: string,
  data: {
    kind: NotificationKind;
    title: string;
    body: string;
    href: string;
    resourceType: string;
    resourceId: string;
  },
) {
  try {
    await withWorkerTenantContext(tenantId, async (tx) => {
      const existing = await tx.notification.findFirst({
        where: {
          tenantId,
          staffId,
          kind: data.kind,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
          readAt: null,
        },
      });
      if (existing) {
        await tx.notification.update({
          where: { id: existing.id },
          data: { title: data.title, body: data.body, href: data.href, createdAt: new Date() },
        });
        return;
      }
      await tx.notification.create({
        data: {
          tenantId,
          staffId,
          kind: data.kind,
          title: data.title,
          body: data.body,
          href: data.href,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Idempotenz-Index (Q-2 erweitert) hat eine parallele Notification bereits
      // persistiert. Kein Fehler — wir wollten genau das gleiche schreiben.
      return;
    }
    throw err;
  }
}
