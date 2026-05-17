// =============================================================================
// tax-deadline-materialize-Worker
//
// Täglich:
//   1. Aktive TaxScheduleConfigs durchgehen, Termine für die nächsten N Tage
//      idempotent in tax_deadline einfügen.
//   2. Wenn ein Termin im Reminder-Fenster liegt (dueDate - reminderDaysBefore
//      <= today), automatisch eine Anforderung an den Mandanten erzeugen
//      (Status: REMINDED).
//   3. Vergangene Termine ohne Erledigung als OVERDUE markieren.
//
// Mandant muss freigeschaltet (allowActive) sein — sonst keine Termine.
// Nutzt prismaOwner (BYPASSRLS) und filtert manuell nach tenantId, wie in
// den anderen Worker-Jobs.
// =============================================================================

import { Worker } from 'bullmq';
import { type TaxScheduleKind, type Prisma } from '@prisma/client';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { generateDeadlines, SCHEDULE_LABELS, type GermanRegion } from '@taxtronik/tax';
import { prismaOwner } from '../prisma-owner';

const HORIZON_DAYS = 90;

export const taxDeadlineMaterializeWorker = new Worker<ChecksJob>(
  'tax-deadline-materialize',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    const now = new Date();
    const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
    let totalCreated = 0;
    let totalRequests = 0;
    let totalOverdue = 0;

    for (const tenantId of tenantIds) {
      // System-Staff für createdByStaff der Auto-Anforderungen — wir nehmen
      // den ersten ADMIN/PARTNER. Ohne so einen Account: skip.
      const systemStaff = await prismaOwner.staffUser.findFirst({
        where: {
          tenantId,
          active: true,
          roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
        },
        select: { id: true },
      });
      if (!systemStaff) {
        log.info({ tenantId }, 'tax-deadline: kein ADMIN/PARTNER, skip');
        continue;
      }

      // 1. Region des Tenants laden (für Werktagsverschiebung)
      const regionRow = await prismaOwner.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: 'tax_region' } },
      });
      const region = ((regionRow?.value as { region?: string } | null)?.region ?? null) as GermanRegion | null;

      // 2. Termine materialisieren
      const configs = await prismaOwner.taxScheduleConfig.findMany({
        where: { tenantId, active: true },
        include: { client: { select: { id: true, allowActive: true } } },
      });
      for (const cfg of configs) {
        if (!cfg.client.allowActive) continue;
        const candidates = generateDeadlines(
          cfg.kind as TaxScheduleKind,
          now,
          horizon,
          cfg.hasDauerfrist,
          region,
        );
        for (const c of candidates) {
          // Keine Vergangenheits-Termine — Mandanten werden unterjährig übernommen
          if (c.dueDate.getTime() < now.getTime()) continue;
          const existing = await prismaOwner.taxDeadline.findUnique({
            where: {
              tenantId_clientId_kind_period: {
                tenantId,
                clientId: cfg.clientId,
                kind: c.kind,
                period: c.period,
              },
            },
          });
          if (existing) continue;
          await prismaOwner.taxDeadline.create({
            data: {
              tenantId,
              clientId: cfg.clientId,
              configId: cfg.id,
              kind: c.kind,
              period: c.period,
              dueDate: c.dueDate,
            },
          });
          totalCreated += 1;
        }
      }

      // 2. Auto-Anforderungen
      const upcoming = await prismaOwner.taxDeadline.findMany({
        where: {
          tenantId,
          status: 'PLANNED',
          requestId: null,
          config: { reminderDaysBefore: { gt: 0 } },
        },
        include: { config: { select: { reminderDaysBefore: true } } },
      });
      for (const dl of upcoming) {
        const reminderDays = dl.config?.reminderDaysBefore ?? 0;
        if (reminderDays === 0) continue;
        const remindFrom = new Date(
          dl.dueDate.getTime() - reminderDays * 24 * 60 * 60 * 1000,
        );
        if (remindFrom > now) continue;

        const dueLabel = new Intl.DateTimeFormat('de-DE').format(dl.dueDate);
        const kindLabel = SCHEDULE_LABELS[dl.kind as TaxScheduleKind];
        const txData: Prisma.RequestCreateInput = {
          tenant: { connect: { id: tenantId } },
          client: { connect: { id: dl.clientId } },
          title: `${kindLabel} ${dl.period} bis ${dueLabel}`,
          description: `Bitte stellen Sie die Unterlagen für ${kindLabel} ${dl.period} bereit. Fälligkeit: ${dueLabel}.`,
          priority: 'NORMAL',
          createdByStaff: systemStaff.id,
          dueAt: dl.dueDate,
        };
        const req = await prismaOwner.request.create({ data: txData });
        await prismaOwner.taxDeadline.update({
          where: { id: dl.id },
          data: { requestId: req.id, status: 'REMINDED' },
        });
        totalRequests += 1;
      }

      // 3. OVERDUE markieren
      const ov = await prismaOwner.taxDeadline.updateMany({
        where: {
          tenantId,
          status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS'] },
          dueDate: { lt: now },
        },
        data: { status: 'OVERDUE' },
      });
      totalOverdue += ov.count;
    }

    log.info(
      { created: totalCreated, requests: totalRequests, overdue: totalOverdue },
      'tax-deadline-materialize: done',
    );
    return { created: totalCreated, requests: totalRequests, overdue: totalOverdue };
  },
  { connection, concurrency: 1 },
);

taxDeadlineMaterializeWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'tax-deadline-materialize: failed');
});
