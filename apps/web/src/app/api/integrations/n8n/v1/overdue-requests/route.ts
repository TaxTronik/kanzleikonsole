import { NextResponse, type NextRequest } from 'next/server';
import {
  authenticateN8nCallback,
  n8nCallbackRejectResponse,
  runReservedN8nCallback,
} from '@/server/n8n/callback-auth';
import { getOverdueRequestsForTenant } from '@/server/n8n/operations';
import { log } from '@/server/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await authenticateN8nCallback(request, 'requests:read');
  if (!auth.ok) {
    log.warn(
      { component: 'n8n-callback', reason: auth.reason, status: auth.status },
      'n8n callback rejected',
    );
    return n8nCallbackRejectResponse(auth);
  }

  if (request.nextUrl.searchParams.has('tenantId')) {
    return NextResponse.json({ error: 'tenant_id_not_allowed' }, { status: 400 });
  }

  return runReservedN8nCallback(auth, async () => {
    const result = await getOverdueRequestsForTenant(auth.tenantId);
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
