// =============================================================================
// GET /api/staff/document-types
//
// Aktive Datei-Typen des Tenants (Kern-Typen + eigene). Vom Upload-/Retag-UI
// genutzt, um Typen + ihre Schutzstufe anzubieten.
// =============================================================================

import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { tenantId, staffId } = session.user;

  const types = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.documentType.findMany({
      where: { active: true },
      orderBy: [{ builtin: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        tier: true,
        retentionYears: true,
        builtin: true,
        classificationKey: true,
      },
    }),
  );

  return NextResponse.json({ types }, { headers: { 'cache-control': 'private, no-store' } });
}
