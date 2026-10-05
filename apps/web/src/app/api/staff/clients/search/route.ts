// =============================================================================
// GET /api/staff/clients/search?q=...&filter=active,notEnded
//
// Serversuche der ClientCombobox. Liefert höchstens CLIENT_PICKER_LIMIT
// Mandanten (plus `limited`), ohne Suchbegriff die eigenen Zuordnungen.
// Sichtbarkeit wie in allen Mandantenlisten (`accessibleClientsWhereFor`);
// die Filter verengen nur. Suchbegriffe werden nicht protokolliert.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { withTenantContext } from '@taxtronik/db';
import { staffAuth } from '@/server/auth/staff';
import { checkStaffClientPickerLimit } from '@/server/rate-limit';
import { searchClientPickerTx } from '@/server/clients/picker';
import { parseClientPickerRequest } from '@/lib/client-picker';

const NO_STORE = { 'cache-control': 'private, no-store' };

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const request = parseClientPickerRequest(req.nextUrl.searchParams);
  if (!request) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400, headers: NO_STORE });
  }

  const rl = await checkStaffClientPickerLimit(session.user.staffId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...NO_STORE, 'retry-after': String(rl.retryAfter) } },
    );
  }

  const { tenantId, staffId } = session.user;
  const result = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    searchClientPickerTx(tx, session, request),
  );
  return NextResponse.json(result, { headers: NO_STORE });
}
