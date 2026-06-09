// =============================================================================
// poa-expiry-check-Worker
//
// Überwacht den Ablauf signierter Vollmachten (analog gwg-expiry-check):
//   - 30 Tage vor validUntil: Hinweis an Bearbeiter (POA_EXPIRY_SOON)
//   - bei/nach Ablauf:         Status → EXPIRED + Hinweis (POA_EXPIRED)
//
// Empfänger: Haupt-/Berufsträger des Mandanten, sonst ADMIN/PARTNER als
// Fallback. Idempotent über upsertNotification (eine Notification pro
// Empfänger und Vollmacht). Nur SIGNED-Vollmachten mit gesetztem validUntil.
// =============================================================================

import { Worker } from 'bullmq';
import type { NotificationKind } from '@prisma/client';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { upsertNotification } from '../notify';

// RF-8: record() braucht nur den Tx — gleiches Muster wie risk-analyse-llm.ts.
const evidence = new EvidenceService(new LocalTimestampAdapter());

const WARN_DAYS_SOON = 30;

function dateFmt(d: Date): string {
  return new Intl.DateTimeFormat('de-DE').format(d);
}

export const poaExpiryWorker = new Worker<ChecksJob>(
  'poa-expiry-check',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    let soon = 0;
    let expired = 0;

    for (const tenantId of tenantIds) {
      const now = new Date();
      const adminPartners = await prismaOwner.staffUser.findMany({
        where: {
          tenantId,
          active: true,
          roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
        },
        select: { id: true },
      });

      // RF-14: nur das Relevanz-Fenster laden (validUntil <= now + 30 Tage =
      // Warn-Grenze) statt aller SIGNED-Vollmachten mit validUntil — der
      // In-Memory-Filter (daysLeft > 30 → skip) bleibt als exakte Tagesrechnung.
      const soonCutoff = new Date(now.getTime() + WARN_DAYS_SOON * 24 * 60 * 60 * 1000);
      const candidates = await prismaOwner.powerOfAttorney.findMany({
        where: { tenantId, status: 'SIGNED', validUntil: { not: null, lte: soonCutoff } },
        include: {
          client: {
            select: {
              name: true,
              responsibilities: {
                where: { role: { in: ['HAUPTBEARBEITER', 'BERUFSTRAEGER'] } },
                select: { staffId: true },
              },
            },
          },
        },
      });

      for (const poa of candidates) {
        const daysLeft = Math.ceil((poa.validUntil!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        const isExpired = daysLeft <= 0;
        if (!isExpired && daysLeft > WARN_DAYS_SOON) continue;

        const respIds = poa.client.responsibilities.map((r) => r.staffId);
        const recipients = Array.from(
          new Set(respIds.length > 0 ? respIds : adminPartners.map((s) => s.id)),
        );
        if (recipients.length === 0) continue;

        if (isExpired) {
          // RF-8: Statuswechsel im Tenant-Context + Audit-Record in derselben
          // TX (vorher: nacktes prismaOwner-Update ohne evidence.record).
          await withWorkerTenantContext(tenantId, async (tx) => {
            const res = await tx.powerOfAttorney.updateMany({
              where: { id: poa.id, status: 'SIGNED' },
              data: { status: 'EXPIRED' },
            });
            if (res.count > 0) {
              await evidence.record(tx, {
                tenantId,
                actorType: 'SYSTEM',
                actorId: null,
                action: 'poa.expire',
                resourceType: 'power_of_attorney',
                resourceId: poa.id,
                before: { status: 'SIGNED' },
                after: { status: 'EXPIRED', validUntil: poa.validUntil },
              });
            }
          });
        }

        const title = isExpired
          ? `Vollmacht abgelaufen — ${poa.client.name}`
          : `Vollmacht läuft in ${daysLeft} Tagen ab — ${poa.client.name}`;
        const body = `„${poa.subject}“ (${poa.signerName}), gültig bis ${dateFmt(poa.validUntil!)}.${
          isExpired ? ' Bitte bei Bedarf eine neue Vollmacht einholen.' : ''
        }`;

        for (const staffId of recipients) {
          await upsertNotification(tenantId, staffId, {
            kind: (isExpired ? 'POA_EXPIRED' : 'POA_EXPIRY_SOON') as NotificationKind,
            title,
            body,
            href: `/staff/poa/${poa.id}`,
            resourceType: 'power_of_attorney',
            resourceId: poa.id,
          });
        }
        if (isExpired) expired += recipients.length;
        else soon += recipients.length;
      }
    }

    log.info({ soon, expired }, 'poa-expiry: done');
    return { soon, expired };
  },
  { connection, concurrency: 1 },
);

poaExpiryWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'poa-expiry: failed');
});
