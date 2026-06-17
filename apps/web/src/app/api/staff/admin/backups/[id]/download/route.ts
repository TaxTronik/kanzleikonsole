import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { sanitizeFilenameForHeader } from '@taxtronik/storage';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { getClientIp, checkStaffBackupDownloadLimit } from '@/server/rate-limit';
import { backupDownloadFilename, backupLocalPathForKey } from '@/server/backup/local-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const source = req.nextUrl.searchParams.get('source') ?? 'auto';
  if (source !== 'auto' && source !== 'local' && source !== 's3') {
    return NextResponse.json({ error: 'invalid_source' }, { status: 400 });
  }

  const rl = await checkStaffBackupDownloadLimit(staffId, source);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  const rec = await withTenantContext(
    ctx,
    async (tx) => {
      const backup = await tx.backupRecord.findFirst({
        where: { id, tenantId, status: 'SUCCESS' },
        select: {
          id: true,
          bucket: true,
          key: true,
          sizeBytes: true,
        },
      });
      if (!backup?.bucket || !backup.key) return null;
      return backup;
    },
  );

  if (!rec) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const filename = sanitizeFilenameForHeader(backupDownloadFilename(rec.key!));
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'private, no-store',
  };

  const local = source !== 's3' ? await tryLocalBackupStream(rec.key!, rec.sizeBytes) : null;
  if (local) {
    await recordBackupDownload(ctx, req, rec, 'local');
    return new NextResponse(local.body, {
      status: 200,
      headers: {
        ...baseHeaders,
        'content-length': String(local.contentLength),
        'x-backup-source': 'local',
      },
    });
  }
  if (source === 'local') {
    return NextResponse.json({ error: 'backup_local_unavailable' }, { status: 404 });
  }

  try {
    const s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      forcePathStyle: true,
    });
    const obj = await s3.send(new GetObjectCommand({ Bucket: rec.bucket!, Key: rec.key! }));
    if (!obj.Body) {
      return NextResponse.json({ error: 'backup_object_empty' }, { status: 502 });
    }
    const headers: Record<string, string> = { ...baseHeaders, 'x-backup-source': 's3' };
    if (typeof obj.ContentLength === 'number') headers['content-length'] = String(obj.ContentLength);

    await recordBackupDownload(ctx, req, rec, 's3');
    return new NextResponse(Readable.toWeb(obj.Body as Readable) as ReadableStream<Uint8Array>, {
      status: 200,
      headers,
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'backup_object_unavailable', message: (e as Error).message },
      { status: 502 },
    );
  }
}

async function recordBackupDownload(
  ctx: { tenantId: string; actorId: string; actorType: 'STAFF' },
  req: NextRequest,
  rec: { id: string; bucket: string | null; key: string | null; sizeBytes: bigint | null },
  source: 'local' | 's3',
): Promise<void> {
  await withTenantContext(ctx, (tx) =>
    evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'backup.download',
      resourceType: 'backup_record',
      resourceId: rec.id,
      ip: getClientIp(req.headers),
      userAgent: req.headers.get('user-agent'),
      after: {
        bucket: rec.bucket,
        key: rec.key,
        source,
        sizeBytes: rec.sizeBytes?.toString() ?? null,
      },
    }),
  );
}

async function tryLocalBackupStream(
  key: string,
  expectedSize: bigint | null,
): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number } | null> {
  try {
    const localPath = backupLocalPathForKey(key);
    const info = await stat(localPath);
    if (!info.isFile()) return null;
    if (expectedSize !== null && BigInt(info.size) !== expectedSize) return null;
    return {
      body: Readable.toWeb(createReadStream(localPath)) as ReadableStream<Uint8Array>,
      contentLength: info.size,
    };
  } catch {
    return null;
  }
}
