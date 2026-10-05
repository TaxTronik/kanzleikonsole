'use server';

import { revalidatePath } from 'next/cache';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { getAuditRotateQueue } from '@/server/jobs/audit-rotate-queue';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { toActionError } from '@/server/auth/rbac';
import { withTimeout } from '@/lib/with-timeout';

export async function triggerAuditRotateAction(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  try {
    await triggerAuditRotate(g);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath('/staff/admin/archive');
  return { ok: true };
}

async function triggerAuditRotate({
  tenantId,
  staffId,
  ctx,
}: {
  tenantId: string;
  staffId: string;
  ctx: TenantContext;
}): Promise<void> {
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

  if (!rotatable) return;

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
}
