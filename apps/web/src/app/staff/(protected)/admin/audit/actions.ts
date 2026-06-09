'use server';

import { redirect } from 'next/navigation';
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

  await enqueueAuditVerify(g.tenantId);

  redirect('/staff/admin/audit?verify=queued');
}
