// =============================================================================
// GET /api/n8n/overdue-requests?tenantId=<uuid>
//
// Liefert offene/in-Bearbeitung-Requests eines Tenants, deren Fälligkeit
// überschritten ist. n8n MUSS `tenantId` als Query-Parameter mitschicken.
//
// Defense in Depth (Audit Round 14, Finding 1): Vor dem Audit lief dieser
// Endpoint cross-tenant — die Sicherheit hing allein am N8N_HMAC_SECRET.
// Bei HMAC-Leak oder kompromittiertem n8n wären beliebige Cross-Tenant-
// Reads möglich gewesen. Jetzt: `tenantId` ist Teil der Query und somit der
// signierten URL (verify.ts:56 inkludiert `nextUrl.search`) UND
// erzwungener DB-Filter.
//
// Response: { requests: [{ id, clientName, contactEmail?, contactName?,
//                          title, dueAt, daysOverdue, signerEmail }] }
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { n8nRejectResponse, runReservedN8nRequest, verifyN8nSignature } from '@/server/n8n/verify';
import { getOverdueRequestsForTenant } from '@/server/n8n/operations';
import { log } from '@/server/logger';
import { legacyN8nCallbackDisabledResponse } from '@/server/n8n/legacy-access';

const TenantIdSchema = z.string().uuid();

export async function GET(req: NextRequest) {
  const disabled = legacyN8nCallbackDisabledResponse();
  if (disabled) return disabled;

  const ver = await verifyN8nSignature(req);
  if (!ver.ok) {
    // Audit 2: generische Antwort, Detail nur ins Log.
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected');
    // Befund 10: zentrales Status-Mapping (503/500 retrybar, sonst 401).
    return n8nRejectResponse(ver);
  }

  const tenantId = TenantIdSchema.safeParse(req.nextUrl.searchParams.get('tenantId'));
  if (!tenantId.success) {
    return NextResponse.json({ error: 'tenantId query parameter required' }, { status: 400 });
  }

  return runReservedN8nRequest(ver, async () =>
    NextResponse.json(await getOverdueRequestsForTenant(tenantId.data)),
  );
}
