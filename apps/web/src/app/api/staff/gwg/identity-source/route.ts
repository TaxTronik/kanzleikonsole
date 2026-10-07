import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withTenantContext } from '@taxtronik/db';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { loadIdentitySourceTx, readIdentitySourceBytes } from '@/server/gwg/identity-source';
import { log } from '@/server/logger';
import { checkRateLimit } from '@/server/rate-limit';
import { bytesResponseBody } from '@taxtronik/storage';

const Query = z.object({
  clientId: z.string().uuid(),
  checkId: z.string().uuid(),
  documentId: z.string().uuid(),
});
export async function GET(request: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const query = Query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const { tenantId, staffId } = session.user;
  const limit = await checkRateLimit(`gwg-identity-source:${tenantId}:${staffId}`, {
    max: 60,
    windowSec: 60,
  });
  if (!limit.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  const source = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      if (!(await canAccessClientTx(tx, session, query.data.clientId))) return null;
      const check = await tx.gwgCheck.findFirst({
        where: { id: query.data.checkId, clientId: query.data.clientId, destroyedAt: null },
        select: { id: true },
      });
      if (!check) return null;
      const source = await loadIdentitySourceTx(tx, { tenantId, ...query.data });
      if (source)
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'gwg.identity.source.view',
          resourceType: 'document',
          resourceId: source.documentId,
          after: { clientId: query.data.clientId, versionId: source.version.id },
        });
      return source;
    },
  );
  if (!source) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    return new NextResponse(bytesResponseBody(await readIdentitySourceBytes(source)), {
      headers: {
        'Content-Type': source.mimeType,
        'Cache-Control': 'private, no-store',
        'X-Identity-Version': source.version.id,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    // F-05: Die gespeicherte Ausweisquelle ist nicht lesbar oder bestätigt
    // ihre Prüfsumme nicht; ins Log nur IDs und Fehlerklasse.
    log.warn(
      {
        component: 'gwg-identity-source',
        documentId: source.documentId,
        versionId: source.version.id,
        errName: error instanceof Error ? error.name : typeof error,
        err: error instanceof Error ? error.message : String(error),
      },
      'gwg-identity-source: Quelle nicht lesbar',
    );
    return NextResponse.json({ error: 'source_unavailable' }, { status: 409 });
  }
}
