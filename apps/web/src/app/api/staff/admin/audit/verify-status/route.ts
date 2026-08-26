import { NextResponse, type NextRequest } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { AUDIT_VERIFY_RESULT_SETTING_KEY, type PersistedVerifyResult } from '@taxtronik/evidence';

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
  // Optionaler Trigger-Zeitpunkt: erlaubt „fertig", sobald IRGENDEIN Lauf nach
  // dem Trigger persistiert wurde — auch wenn die requestId zwischenzeitlich vom
  // nächtlichen Lauf (requestId=null) oder einem parallelen Trigger überschrieben
  // wurde. Ohne diesen Fallback blieb das Polling in solchen Fällen ewig hängen.
  const queuedAtParam = req.nextUrl.searchParams.get('queuedAt');
  const queuedAtMs = queuedAtParam ? Date.parse(queuedAtParam) : NaN;

  const { tenantId, staffId } = session.user;
  const result = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      ((await readTenantSettingValue(tx, tenantId, AUDIT_VERIFY_RESULT_SETTING_KEY)) ??
        null) as PersistedVerifyResult | null,
  );

  const checkedAtMs = result?.checkedAt ? Date.parse(result.checkedAt) : NaN;
  const doneByRequestId = !!result && result.requestId === requestId;
  const doneByTimestamp =
    !!result && !Number.isNaN(queuedAtMs) && !Number.isNaN(checkedAtMs) && checkedAtMs > queuedAtMs;

  return NextResponse.json(
    {
      done: doneByRequestId || doneByTimestamp,
      checkedAt: result?.checkedAt ?? null,
      ok: result?.ok ?? null,
      requestId: result?.requestId ?? null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
