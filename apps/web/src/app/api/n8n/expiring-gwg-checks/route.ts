// =============================================================================
// GET /api/n8n/expiring-gwg-checks?withinDays=30&tenantId=<uuid>
//
// Legacy-Kompatibilitätsroute. Auch hier ist der Tenant verpflichtend; ein
// globales HMAC-Secret darf niemals einen Cross-Tenant-Read ermöglichen. Neue
// Workflows verwenden die tenantgebundene v1-Route ohne tenantId-Parameter.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { n8nRejectResponse, runReservedN8nRequest, verifyN8nSignature } from '@/server/n8n/verify';
import { getExpiringGwgChecks } from '@/server/n8n/operations';
import { log } from '@/server/logger';
import { legacyN8nCallbackDisabledResponse } from '@/server/n8n/legacy-access';

const TenantIdSchema = z.string().uuid();

export async function GET(req: NextRequest) {
  const disabled = legacyN8nCallbackDisabledResponse();
  if (disabled) return disabled;

  const ver = await verifyN8nSignature(req);
  if (!ver.ok) {
    // Audit Round 15, Finding 2: generische Antwort, Detail nur ins Log.
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected');
    // Befund 10: zentrales Status-Mapping (503/500 retrybar, sonst 401).
    return n8nRejectResponse(ver);
  }

  const withinDays = Number(req.nextUrl.searchParams.get('withinDays') ?? '30');
  if (!Number.isFinite(withinDays) || withinDays < 1 || withinDays > 365) {
    return NextResponse.json({ error: 'invalid withinDays' }, { status: 400 });
  }

  const tenantId = TenantIdSchema.safeParse(req.nextUrl.searchParams.get('tenantId'));
  if (!tenantId.success) {
    return NextResponse.json({ error: 'tenantId query parameter required' }, { status: 400 });
  }

  return runReservedN8nRequest(ver, async () =>
    NextResponse.json(await getExpiringGwgChecks(tenantId.data, withinDays)),
  );
}
