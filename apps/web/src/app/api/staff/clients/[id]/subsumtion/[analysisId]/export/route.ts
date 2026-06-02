// =============================================================================
// GET /api/staff/clients/[id]/subsumtion/[analysisId]/export?format=docx|pdf
//
// Lädt das Report-Modell (tenant-scoped, per-Mandant autorisiert) und streamt
// den annotierten Sachverhalt + die Markierungs-Tabelle als DOCX oder PDF.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { requireSubsumtionAccess, ForbiddenError, UnauthorizedError } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { buildReportModel } from '@/server/risk/export/report-model';
import { renderDocx } from '@/server/risk/export/to-docx';
import { renderPdf } from '@/server/risk/export/to-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeFilename(title: string, ext: string): string {
  const base = (title || 'Subsumtion').replace(/[^\p{L}\p{N} _.-]+/gu, '_').slice(0, 80).trim() || 'Subsumtion';
  return `${base}.${ext}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; analysisId: string }> },
) {
  const { id, analysisId } = await params;

  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  const modules = await readModules(ctx);
  if (!modules.risk) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Mandant aus der Analyse ableiten + gegen die URL prüfen (IDOR-Schutz), dann
  // per-Mandant autorisieren (nicht über die clientId aus der URL).
  const a = await withTenantContext(ctx, (tx) =>
    tx.riskAnalysis.findUnique({ where: { id: analysisId }, select: { clientId: true } }),
  );
  if (!a?.clientId || a.clientId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    await requireSubsumtionAccess(a.clientId);
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    throw e;
  }

  // Optionale Auswahl: nur diese Markierungen exportieren (`?marks=id1,id2`).
  // Fremde/ungültige IDs filtert buildReportModel via Schnittmenge weg (RLS-scoped).
  const marksParam = req.nextUrl.searchParams.get('marks');
  const markingIds = marksParam
    ? marksParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 1000)
    : undefined;

  const model = await buildReportModel(ctx, analysisId, markingIds ? { markingIds } : undefined);
  if (!model) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const format = req.nextUrl.searchParams.get('format') === 'pdf' ? 'pdf' : 'docx';
  const isPdf = format === 'pdf';
  const buf = isPdf ? await renderPdf(model) : await renderDocx(model);
  const filename = safeFilename(model.title, isPdf ? 'pdf' : 'docx');

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'content-type': isPdf
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
    },
  });
}
