import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sanitizeFilenameForHeader } from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { toActionError } from '@/server/auth/rbac';
import { checkStaffExportLimit } from '@/server/rate-limit';
import { loadArtifactDownload } from '@/server/mandate-expansion/artifacts';
import { filenameWithExtension } from '@/server/storage/preview-mime';
export async function GET(request: NextRequest) {
  const parsed = z.uuid().safeParse(request.nextUrl.searchParams.get('artifactId'));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Eine konkret abgelegte Ausgabe auswählen.' },
      { status: 400 },
    );
  const auth = await staffActionGuard();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 403 });
  if (!(await checkStaffExportLimit('mandate-artifact-download', auth.staffId)).ok)
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  try {
    const artifact = await withTenantContext(auth.ctx, (tx) =>
      tx.mandateArtifact.findFirst({
        where: { id: parsed.data, tenantId: auth.tenantId },
        select: { kind: true },
      }),
    );
    if (!artifact) return NextResponse.json({ error: 'Ausgabe nicht verfügbar.' }, { status: 404 });
    const guard = await staffActionGuard({
      module: artifact.kind === 'STRUCTURE' ? 'mandateStructure' : 'mandateOffboarding',
      requireAdmin: artifact.kind === 'OFFBOARDING',
    });
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 });
    const data = await loadArtifactDownload(guard.session, guard.ctx, parsed.data);
    return new NextResponse(new Uint8Array(data.bytes), {
      headers: {
        'Content-Type': data.mimeType,
        'Content-Disposition': `attachment; filename="${sanitizeFilenameForHeader(filenameWithExtension(data.title, data.mimeType))}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: toActionError(error).error }, { status: 400 });
  }
}
