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

// Pro Tenant serialisiert evidenceService.record die Audit-Inserts über einen
// pg_advisory_xact_lock, der bis zum Tx-Ende gehalten wird. Liefe der ganze Bulk
// (bis 200 Items) in EINER Tx, blockierte der Lock alle anderen Audit-Writes des
// Tenants für die volle Tx-Dauer (und näherte sich dem 15-s-Tx-Timeout). Wir
// splitten daher in kleine Tx-Chunks: kurzer Lock, andere Writes kommen
// dazwischen durch. Trade-off: nicht mehr atomar — bricht ein späterer Chunk ab,
// bleiben frühere committet (für ein idempotentes Bulk-Close akzeptabel; der
// Re-Run schließt den Rest).
const BULK_CHUNK = 25;

export async function bulkCloseRequestsAction(input: { ids: string[] }): Promise<BulkResult> {
  // Massenoperationen über mehrere Mandanten hinweg — nur ADMIN/PARTNER.
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return { ok: false, affected: 0, error: g.error };
  const { tenantId, staffId, ctx } = g;

  const parsed = BulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, affected: 0, error: 'Validierungsfehler.' };

  const closedIds: string[] = [];
  let failed = false;
  try {
    for (let i = 0; i < parsed.data.ids.length; i += BULK_CHUNK) {
      const chunkIds = parsed.data.ids.slice(i, i + BULK_CHUNK);
      const chunkClosed = await withTenantContext(ctx, async (tx) => {
        const before = await tx.request.findMany({
          where: { id: { in: chunkIds }, status: { notIn: ['CLOSED', 'CANCELLED'] } },
          select: { id: true, status: true },
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
      closedIds.push(...chunkClosed);
    }
  } catch {
    // Bereits committete Chunks bleiben gültig → als Teilerfolg melden.
    failed = true;
  }

  // n8n-Events fire-and-forget — NUR über die tatsächlich geschlossenen Requests.
  // Über die rohe Eingabe (parsed.data.ids) zu feuern würde request.closed auch
  // für bereits geschlossene, nicht existierende oder RLS-gefilterte IDs auslösen
  // → spurious, client-wirksame Downstream-Notifications.
  // Der Bulk-Endpunkt verarbeitet bis zu 200 Anforderungen. Kleine Batches
  // begrenzen gleichzeitige Outbox-Transaktionen und damit den DB-Pool-Druck.
  for (let offset = 0; offset < closedIds.length; offset += 10) {
    await Promise.all(
      closedIds
        .slice(offset, offset + 10)
        .map((id) => emitN8nEvent('request.closed', { tenantId, requestId: id }, { tenantId })),
    );
  }
  revalidatePath('/staff/requests');
  return failed
    ? {
        ok: false,
        affected: closedIds.length,
        error: 'Teilweise abgeschlossen — bitte erneut versuchen.',
      }
    : { ok: true, affected: closedIds.length };
}
