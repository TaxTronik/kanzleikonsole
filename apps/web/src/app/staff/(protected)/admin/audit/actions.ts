'use server';

import { redirect } from 'next/navigation';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';
import { enqueueAuditVerify } from '@/server/jobs/audit-verify-queue';

/**
 * „Jetzt prüfen" — stößt die Chain-Verifikation als Hintergrund-Job an
 * (Worker: audit-verify-check, nur dieser Tenant). Die Seite zeigt danach das
 * persistierte Ergebnis; der Lauf selbst läuft NICHT mehr im Render-Pfad.
 */
export async function triggerAuditVerifyAction(): Promise<void> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx } = g;

  await enqueueAuditVerify(tenantId);

  // Manueller Trigger gehört in die Chain (analog audit.rotate.trigger) —
  // WER die Verifikation angestoßen hat, ist Teil der Rechenschaft.
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'audit.verify.trigger',
      resourceType: 'audit_log',
      after: { triggeredManually: true },
    });
  });

  redirect('/staff/admin/audit?verify=queued');
}
