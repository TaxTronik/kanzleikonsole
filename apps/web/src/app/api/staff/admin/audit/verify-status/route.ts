import { NextResponse, type NextRequest } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import {
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const requestId = req.nextUrl.searchParams.get('requestId');
  if (!requestId) {
    return NextResponse.json({ error: 'missing_request_id' }, { status: 400 });
  }

  const { tenantId, staffId } = session.user;
  const result = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const row = await tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
      });
      return (row?.value ?? null) as PersistedVerifyResult | null;
    },
  );

  return NextResponse.json(
    {
      done: result?.requestId === requestId,
      checkedAt: result?.checkedAt ?? null,
      ok: result?.ok ?? null,
      requestId: result?.requestId ?? null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
