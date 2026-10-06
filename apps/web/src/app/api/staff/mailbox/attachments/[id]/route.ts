import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenantContext } from '@taxtronik/db';
import { bytesResponseBody, fetchVerifiedObjectBytes, getBucketForTier } from '@taxtronik/storage';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { staffAuth } from '@/server/auth/staff';
import { staffActionGuard } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await staffAuth())?.user)
    return NextResponse.json({ error: 'Nicht angemeldet.' }, { status: 401 });
  const g = await staffActionGuard({
    requirePermission: 'INBOUND_MAIL_MANAGE',
    module: 'smartMailbox',
  });
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: 403 });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: 'Nicht gefunden.' }, { status: 404 });
  try {
    const a = await withTenantContext(g.ctx, (tx) =>
      tx.inboundAttachment.findFirst({
        where: {
          id: id.data,
          status: { in: ['CLEAN', 'IMPORTING', 'IMPORTED'] },
          message: { mailbox: { tenantId: g.tenantId } },
        },
      }),
    );
    if (!a?.storageKey)
      return NextResponse.json(
        { error: 'Anhang nicht verfügbar oder nicht geprüft.' },
        { status: 404 },
      );
    // R-05: Größe und SHA-256 des geprüften Anhangs vor Audit und Auslieferung.
    const bytes = await fetchVerifiedObjectBytes(
      { bucket: getBucketForTier('NONE'), key: a.storageKey },
      { sizeBytes: a.sizeBytes, sha256: a.sha256 },
    );
    await withTenantContext(g.ctx, async (tx) => {
      if (
        !(await readBooleanTenantModules(tx, g.tenantId)).smartMailbox ||
        !(await tx.inboundAttachment.findFirst({
          where: {
            id: a.id,
            status: { in: ['CLEAN', 'IMPORTING', 'IMPORTED'] },
            sha256: a.sha256,
            storageKey: a.storageKey,
          },
        }))
      )
        throw new Error('Access revoked');
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'STAFF',
        actorId: g.staffId,
        action: 'mailbox.attachment_download',
        resourceType: 'inbound_attachment',
        resourceId: a.id,
        after: { sha256: a.sha256 },
      });
    });
    return new NextResponse(bytesResponseBody(bytes), {
      headers: {
        'Content-Type': a.mimeType,
        'Content-Disposition':
          'attachment; filename="attachment"; filename*=UTF-8\'\'' +
          encodeURIComponent(a.filename).replace(/'/g, '%27'),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Anhang nicht sicher verfügbar.' }, { status: 409 });
  }
}
