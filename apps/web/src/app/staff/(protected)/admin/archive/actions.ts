'use server';

import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { getAuditRotateQueue } from '@/server/jobs/audit-rotate-queue';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';
import { withTimeout } from '@/lib/with-timeout';

export async function triggerAuditRotateAction(): Promise<void> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx } = g;

  // Defense in Depth (gleicht der Button-Deaktivierung auf der Seite): nur
  // anstoßen, wenn tatsächlich rotierbare Einträge existieren (≥ 90 Tage alt
  // und noch nicht archiviert). Sonst no-op-t der Worker, aber wir würden
  // trotzdem ein irreführendes audit.rotate.trigger-Event schreiben, das eine
  // Activity vortäuscht, die nicht stattfand. Wert gleicht MIN_AGE_DAYS im
  // Worker (apps/worker/src/jobs/audit-rotate.ts).
  const ARCHIVE_MIN_AGE_DAYS = 90;
  const rotatable = await withTenantContext(ctx, async (tx) => {
    const lastArchive = await tx.auditArchive.findFirst({
      orderBy: { fromAuditId: 'desc' },
      select: { toAuditId: true },
    });
    const lastArchivedTo = lastArchive?.toAuditId ?? BigInt(0);
    const cutoff = new Date(Date.now() - ARCHIVE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000);
    const entry = await tx.auditLog.findFirst({
      where: { id: { gt: lastArchivedTo }, occurredAt: { lte: cutoff } },
      select: { id: true },
    });
    return !!entry;
  });

  if (!rotatable) {
    revalidatePath('/staff/admin/archive');
    return;
  }

  // BullMQ-Job direkt einreihen — der Worker rotiert nur diesen Tenant.
  // Connection ist modulweiter Singleton (siehe audit-rotate-queue.ts), kein
  // per-Click-Connect/Disconnect mehr.
  // Gedeckelt: bei Redis-Ausfall parkt ioredis den Befehl in der Offline-Queue
  // und das add()-Promise resolved nie — die Action haenge sonst bis zum
  // Browser-Timeout.
  await withTimeout(getAuditRotateQueue().add('audit-rotate', { tenantId }), 2_000);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'audit.rotate.trigger',
      resourceType: 'audit_archive',
      after: { triggeredManually: true },
    });
  });

  revalidatePath('/staff/admin/archive');
}
