import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  authenticateN8nCallback,
  n8nCallbackRejectResponse,
  runReservedN8nCallback,
} from '@/server/n8n/callback-auth';
import { getRequestDetailForTenant } from '@/server/n8n/operations';
import { log } from '@/server/logger';

export const dynamic = 'force-dynamic';

const RequestIdSchema = z.string().uuid();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const id = RequestIdSchema.safeParse((await params).id);
  if (!id.success) {
    return NextResponse.json({ error: 'invalid_request_id' }, { status: 400 });
  }

  return runReservedN8nCallback(auth, async () => {
    const detail = await getRequestDetailForTenant(auth.tenantId, id.data);
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(detail, { headers: { 'cache-control': 'no-store' } });
  });
}
