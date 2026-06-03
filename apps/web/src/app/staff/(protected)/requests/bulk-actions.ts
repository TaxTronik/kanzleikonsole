'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { staffActionGuard } from '@/server/actions/staff-action';

const BulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export interface BulkResult {
  ok: boolean;
  affected: number;
  error?: string;
}

export async function bulkCloseRequestsAction(input: { ids: string[] }): Promise<BulkResult> {
  // Massenoperationen über mehrere Mandanten hinweg — nur ADMIN/PARTNER.
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return { ok: false, affected: 0, error: g.error };
  const { tenantId, staffId, ctx } = g;

  const parsed = BulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, affected: 0, error: 'Validierungsfehler.' };

  const closedIds = await withTenantContext(ctx, async (tx) => {
    const before = await tx.request.findMany({
      where: { id: { in: parsed.data.ids }, status: { notIn: ['CLOSED', 'CANCELLED'] } },
      select: { id: true, status: true, title: true },
    });
    if (before.length === 0) return [] as string[];

    await tx.request.updateMany({
      where: { id: { in: before.map((b) => b.id) } },
      data: { status: 'CLOSED', closedAt: new Date(), closedByStaff: staffId },
    });

    // Pro Eintrag ein Audit-Log
    for (const b of before) {
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'request.close',
        resourceType: 'request',
        resourceId: b.id,
        before: { status: b.status },
        after: { status: 'CLOSED', bulk: true },
      });
    }

    return before.map((b) => b.id);
  });

  // n8n-Events fire-and-forget — NUR über die tatsächlich geschlossenen Requests.
  // Über die rohe Eingabe (parsed.data.ids) zu feuern würde request.closed auch
  // für bereits geschlossene, nicht existierende oder RLS-gefilterte IDs auslösen
  // → spurious, client-wirksame Downstream-Notifications.
  for (const id of closedIds) {
    emitN8nEvent('request.closed', { tenantId, requestId: id });
  }
  revalidatePath('/staff/requests');
  return { ok: true, affected: closedIds.length };
}
