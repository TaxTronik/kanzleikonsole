// =============================================================================
// GET /api/staff/admin/verfahrensdoku
//
// Erzeugt die GoBD-Verfahrensdokumentation aus dem IST-Zustand des Systems
// und liefert sie als Markdown-Download. Admin-gated; die Erzeugung wird in
// der Audit-Chain verankert (wer hat wann den Stand dokumentiert?).
// =============================================================================

import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { checkStaffExportLimit } from '@/server/rate-limit';
import { buildVerfahrensdoku, collectVerfahrensdokuData } from '@/server/compliance/verfahrensdoku';

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  // Defense in Depth: die Collector-Queries sind nicht teuer, aber das
  // Dokument enthält Mengengerüst + Konfiguration — kein Hammering.
  const rl = await checkStaffExportLimit('verfahrensdoku', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const data = await collectVerfahrensdokuData(ctx, session.user.name ?? staffId);
  const markdown = buildVerfahrensdoku(data);

  await withTenantContext(ctx, (tx) =>
    evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'compliance.verfahrensdoku.generated',
      resourceType: 'tenant',
      resourceId: tenantId,
      after: {
        appVersion: data.appVersion,
        gitSha: data.gitSha,
        auditEntries: data.counts.auditEntries,
        documents: data.counts.documents,
      },
    }),
  );

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(markdown, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="verfahrensdokumentation-${date}.md"`,
      'cache-control': 'no-store',
    },
  });
}
