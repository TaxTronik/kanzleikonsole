import { NextResponse, type NextRequest } from 'next/server';
import { withTenantContext } from '@taxtronik/db';
import { staffAuth } from '@/server/auth/staff';
import { checkStaffExportLimit, getClientIp } from '@/server/rate-limit';
import { evidenceService } from '@/server/container';
import { controlFilters } from '@/server/gwg/control-list-model';
import { GwgControlListTooLargeError, loadGwgControlListTx } from '@/server/gwg/control-list';
import { createGwgControlXlsx } from '@/server/gwg/control-xlsx';
export async function GET(request: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const limit = await checkStaffExportLimit('gwg', session.user.staffId);
  if (!limit.ok)
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: limit.retryAfter },
      { status: 429 },
    );
  const filters = controlFilters(Object.fromEntries(request.nextUrl.searchParams));
  try {
    const bytes = await withTenantContext(
      { tenantId: session.user.tenantId, actorId: session.user.staffId, actorType: 'STAFF' },
      async (tx) => {
        const { rows } = await loadGwgControlListTx(tx, session, filters);
        const output = createGwgControlXlsx(rows);
        await evidenceService.record(tx, {
          tenantId: session.user.tenantId,
          actorType: 'STAFF',
          actorId: session.user.staffId,
          action: 'gwg.control.export.xlsx',
          resourceType: 'gwg_control_list',
          after: {
            rows: rows.length,
            groups: new Set(rows.map((row) => row.groupId)).size,
            state: filters.state,
            clientId: filters.clientId || null,
            searchApplied: Boolean(filters.query),
          },
          ip: getClientIp(request.headers),
          userAgent: request.headers.get('user-agent'),
        });
        return output;
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="gwg-kontrollliste-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof GwgControlListTooLargeError)
      return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
