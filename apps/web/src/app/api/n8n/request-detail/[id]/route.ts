// =============================================================================
// GET /api/n8n/request-detail/[id]?tenantId=<uuid>
//
// Defense in Depth (Audit Round 14, Finding 1): tenantId muss in der Query
// stehen und stimmt mit dem geladenen Datensatz überein. Ohne tenantId:
// 400. Mit falschem tenantId für eine fremde Request-ID: 404 — wir
// preisgeben nicht, ob die ID existiert.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { n8nRejectResponse, runReservedN8nRequest, verifyN8nSignature } from '@/server/n8n/verify';
import { getRequestDetailForTenant } from '@/server/n8n/operations';
import { log } from '@/server/logger';
import { legacyN8nCallbackDisabledResponse } from '@/server/n8n/legacy-access';

const TenantIdSchema = z.string().uuid();
const RequestIdSchema = z.string().uuid();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const disabled = legacyN8nCallbackDisabledResponse();
  if (disabled) return disabled;

  const ver = await verifyN8nSignature(req);
  if (!ver.ok) {
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected');
    // Befund 10: zentrales Status-Mapping (503/500 retrybar, sonst 401).
    return n8nRejectResponse(ver);
  }
  const { id } = await params;

  const requestId = RequestIdSchema.safeParse(id);
  if (!requestId.success) {
    return NextResponse.json({ error: 'invalid request id' }, { status: 400 });
  }

  const tenantId = TenantIdSchema.safeParse(req.nextUrl.searchParams.get('tenantId'));
  if (!tenantId.success) {
    return NextResponse.json({ error: 'tenantId query parameter required' }, { status: 400 });
  }

  return runReservedN8nRequest(ver, async () => {
    const r = await getRequestDetailForTenant(tenantId.data, requestId.data);
    if (!r) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // Empfänger, die Mails möchten — n8n-Workflows MÜSSEN diesen Filter
    // respektieren (siehe ClientContact.notificationsEnabled).
    return NextResponse.json(r);
  });
}
