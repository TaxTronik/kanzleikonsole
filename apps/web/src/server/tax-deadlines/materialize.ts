// =============================================================================
// Steuertermin-Materialisierung
//
// Generiert aus den aktiven Schedule-Konfigs konkrete Termine (TaxDeadline)
// für die nächsten N Monate, idempotent (Unique-Key kind+period verhindert
// Duplikate). Erzeugt anschließend Auto-Anforderungen N Tage vor Fälligkeit
// und markiert vergessene Termine als OVERDUE.
//
// Ist als Worker-Job vorgesehen (täglich), kann aber auch ad-hoc aufgerufen
// werden (Server-Action "Termine neu berechnen" für einen Mandanten).
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { generateDeadlines, SCHEDULE_LABELS } from '@taxtronik/tax';
import { readTaxRegion } from '@/server/settings/tax-region';

export interface MaterializeStats {
  configsScanned: number;
  deadlinesCreated: number;
  requestsCreated: number;
  markedOverdue: number;
}

export interface MaterializeOptions {
  /** System-Staff-ID, die als createdBy für Auto-Anforderungen verwendet wird. */
  systemStaffId: string;
  /** Wie weit in die Zukunft Termine erzeugt werden sollen (Default 90 Tage). */
  horizonDays?: number;
  /** Stichdatum, gegen das geprüft wird (Default: heute). */
  now?: Date;
}

export async function materializeTaxDeadlines(
  ctx: TenantContext,
  opts: MaterializeOptions,
): Promise<MaterializeStats> {
  const now = opts.now ?? new Date();
  const horizonDays = opts.horizonDays ?? 90;
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const region = await readTaxRegion(ctx);

  return withTenantContext(ctx, async (tx) => {
    const stats: MaterializeStats = {
      configsScanned: 0,
      deadlinesCreated: 0,
      requestsCreated: 0,
      markedOverdue: 0,
    };

    // 1. Aktive Configs laden
    const configs = await tx.taxScheduleConfig.findMany({
      where: { active: true },
      include: { client: { select: { id: true, allowActive: true } } },
    });
    stats.configsScanned = configs.length;

    // 2. Pro Config alle Kandidaten generieren und idempotent einfügen
    for (const cfg of configs) {
      // Übersprungen wenn Mandant nicht freigeschaltet (GwG)
      if (!cfg.client.allowActive) continue;

      const candidates = generateDeadlines(cfg.kind, now, horizon, cfg.hasDauerfrist, region);
      for (const c of candidates) {
        // Niemals retrospektiv erzeugen — Mandanten werden oft unterjährig
        // übernommen, alte Perioden gehören dem Vorgänger.
        if (c.dueDate.getTime() < now.getTime()) continue;
        // Upsert über Unique (tenantId, clientId, kind, period)
        const existing = await tx.taxDeadline.findUnique({
          where: {
            tenantId_clientId_kind_period: {
              tenantId: ctx.tenantId,
              clientId: cfg.clientId,
              kind: c.kind,
              period: c.period,
            },
          },
        });
        if (existing) continue;

        await tx.taxDeadline.create({
          data: {
            tenantId: ctx.tenantId,
            clientId: cfg.clientId,
            configId: cfg.id,
            kind: c.kind,
            period: c.period,
            dueDate: c.dueDate,
          },
        });
        stats.deadlinesCreated += 1;
      }
    }

    // 3. Auto-Anforderungen für Termine im Reminder-Fenster erzeugen
    const upcoming = await tx.taxDeadline.findMany({
      where: {
        status: 'PLANNED',
        requestId: null,
        config: { reminderDaysBefore: { gt: 0 } },
      },
      include: { config: { select: { reminderDaysBefore: true } } },
    });
    for (const dl of upcoming) {
      const remindFrom = new Date(
        dl.dueDate.getTime() - (dl.config?.reminderDaysBefore ?? 0) * 24 * 60 * 60 * 1000,
      );
      if (remindFrom > now) continue;

      const dueLabel = new Intl.DateTimeFormat('de-DE').format(dl.dueDate);
      const kindLabel = SCHEDULE_LABELS[dl.kind];
      const req = await tx.request.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: dl.clientId,
          title: `${kindLabel} ${dl.period} bis ${dueLabel}`,
          description: `Bitte stellen Sie die Unterlagen für ${kindLabel} ${dl.period} bereit. Fälligkeit: ${dueLabel}.`,
          priority: 'NORMAL',
          createdByStaff: opts.systemStaffId,
          dueAt: dl.dueDate,
        },
      });
      await tx.taxDeadline.update({
        where: { id: dl.id },
        data: { requestId: req.id, status: 'REMINDED' },
      });
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorType: 'SYSTEM',
        actorId: opts.systemStaffId,
        action: 'tax_deadline.auto_request',
        resourceType: 'tax_deadline',
        resourceId: dl.id,
        after: { requestId: req.id, kind: dl.kind, period: dl.period },
      });
      stats.requestsCreated += 1;
    }

    // 4. Vergessene Termine als OVERDUE markieren
    const overdueResult = await tx.taxDeadline.updateMany({
      where: {
        status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS'] },
        dueDate: { lt: now },
      },
      data: { status: 'OVERDUE' },
    });
    stats.markedOverdue = overdueResult.count;

    return stats;
  });
}
