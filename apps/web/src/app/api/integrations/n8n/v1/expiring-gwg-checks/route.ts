import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  authenticateN8nCallback,
  n8nCallbackRejectResponse,
  runReservedN8nCallback,
} from '@/server/n8n/callback-auth';
import { getExpiringGwgChecks } from '@/server/n8n/operations';
import { log } from '@/server/logger';

export const dynamic = 'force-dynamic';

const WithinDaysSchema = z.coerce.number().int().min(1).max(365);

export async function GET(request: NextRequest) {
  const auth = await authenticateN8nCallback(request, 'gwg:read');
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
  const withinDays = WithinDaysSchema.safeParse(
    request.nextUrl.searchParams.get('withinDays') ?? '30',
  );
  if (!withinDays.success) {
    return NextResponse.json({ error: 'invalid_within_days' }, { status: 400 });
  }

  return runReservedN8nCallback(auth, async () => {
    const result = await getExpiringGwgChecks(auth.tenantId, withinDays.data);
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
