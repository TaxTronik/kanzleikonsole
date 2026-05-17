'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';

const BulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export interface BulkResult {
  ok: boolean;
  affected: number;
  error?: string;
}

export async function bulkCloseRequestsAction(input: { ids: string[] }): Promise<BulkResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, affected: 0, error: 'Nicht eingeloggt.' };
  // Massenoperationen über mehrere Mandanten hinweg — nur ADMIN/PARTNER.
  if (!isStaffAdmin(session)) return { ok: false, affected: 0, error: 'Nur ADMIN/PARTNER.' };

  const parsed = BulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, affected: 0, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;

  const affected = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.request.findMany({
        where: { id: { in: parsed.data.ids }, status: { notIn: ['CLOSED', 'CANCELLED'] } },
        select: { id: true, status: true, title: true },
      });
      if (before.length === 0) return 0;

      const result = await tx.request.updateMany({
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

      return result.count;
    },
  );

  // n8n-Events fire-and-forget pro ID
  for (const id of parsed.data.ids) {
    emitN8nEvent('request.closed', { tenantId, requestId: id });
  }
  revalidatePath('/staff/requests');
  return { ok: true, affected };
}
