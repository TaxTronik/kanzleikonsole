// Ablaufkontrolle signierter Vollmachten: Warnung bis 30 Tage vor dem inklusiven
// Gültigkeitstag; EXPIRED erst am Folgetag. POA-LIFECYCLE-001.

import { Worker } from 'bullmq';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { resolveNotificationsTx, upsertNotificationTx } from '@taxtronik/db/notification';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { berlinTodayUtcMidnight, wholeDaysBetween } from '../date-util';

const evidence = new EvidenceService(new LocalTimestampAdapter());
const WARN_DAYS_SOON = 30;
const NO_NOTIFICATIONS = { soon: 0, expired: 0 };

function dateFmt(date: Date): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin' }).format(date);
}

async function processPoa(tenantId: string, poaId: string, todayMidnight: Date) {
  return withWorkerTenantContext(tenantId, async (tx) => {
    // Serialize with revocation/other lifecycle changes and re-read after the lock.
    // Status, evidence, warning resolution and every notification commit together.
    await tx.$queryRaw`
      SELECT id FROM power_of_attorney
      WHERE id = ${poaId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE
    `;
    const poa = await tx.powerOfAttorney.findFirst({
      where: { id: poaId, tenantId, status: 'SIGNED' },
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
    if (!poa || poa.status !== 'SIGNED' || !poa.validUntil) return NO_NOTIFICATIONS;
    const daysLeft = wholeDaysBetween(todayMidnight, poa.validUntil);
    if (daysLeft > WARN_DAYS_SOON) return NO_NOTIFICATIONS;
    const isExpired = daysLeft < 0;

    // ACCESS-NOTIFICATION-RECIPIENT-001: historical assignments alone do not
    // establish an active recipient. Fall back only after the current access filter.
    let recipients = await filterStaffAccessClientTx(
      tx,
      tenantId,
      poa.client.responsibilities.map((entry) => entry.staffId),
      poa.clientId,
    );
    if (recipients.size === 0) {
      const admins = await tx.staffUser.findMany({
        where: { tenantId, active: true, roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } } },
        select: { id: true },
      });
      recipients = await filterStaffAccessClientTx(
        tx,
        tenantId,
        admins.map((entry) => entry.id),
        poa.clientId,
      );
    }

    if (isExpired) {
      const updated = await tx.powerOfAttorney.updateMany({
        where: { id: poa.id, tenantId, status: 'SIGNED', validUntil: { lt: todayMidnight } },
        data: { status: 'EXPIRED' },
      });
      if (updated.count !== 1) return NO_NOTIFICATIONS;
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'power_of_attorney', resourceId: poa.id }],
        kinds: ['POA_EXPIRY_SOON'],
      });
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

    const title = isExpired
      ? `Vollmacht abgelaufen — ${poa.client.name}`
      : daysLeft === 0
        ? `Vollmacht läuft heute ab — ${poa.client.name}`
        : `Vollmacht läuft in ${daysLeft} Tag${daysLeft === 1 ? '' : 'en'} ab — ${poa.client.name}`;
    const body = `„${poa.subject}“ (${poa.signerName}), gültig bis ${dateFmt(poa.validUntil)}.${
      isExpired ? ' Bitte bei Bedarf eine neue Vollmacht einholen.' : ''
    }`;
    for (const staffId of recipients) {
      await upsertNotificationTx(tx, {
        tenantId,
        staffId,
        kind: isExpired ? 'POA_EXPIRED' : 'POA_EXPIRY_SOON',
        title,
        body,
        href: `/staff/poa/${poa.id}`,
        resourceType: 'power_of_attorney',
        resourceId: poa.id,
      });
    }
    return isExpired
      ? { soon: 0, expired: recipients.size }
      : { soon: recipients.size, expired: 0 };
  });
}

export const poaExpiryWorker = new Worker<ChecksJob>(
  JOB_QUEUES.poaExpiry.name,
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((tenant) => tenant.id);
    let soon = 0;
    let expired = 0;
    for (const tenantId of tenantIds) {
      const now = new Date();
      const todayMidnight = berlinTodayUtcMidnight(now);
      const soonCutoff = new Date(now.getTime() + WARN_DAYS_SOON * 24 * 60 * 60 * 1000);
      const candidates = await prismaOwner.powerOfAttorney.findMany({
        where: { tenantId, status: 'SIGNED', validUntil: { not: null, lte: soonCutoff } },
        select: { id: true },
      });
      for (const candidate of candidates) {
        const result = await processPoa(tenantId, candidate.id, todayMidnight);
        soon += result.soon;
        expired += result.expired;
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
