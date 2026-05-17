// =============================================================================
// virus-scan-Worker
//
// Lädt das Objekt vom angegebenen Bucket, scannt mit ClamAV und aktualisiert
// die DocumentVersion-Felder `scan_status` und `scan_completed_at`.
// =============================================================================

import { Worker } from 'bullmq';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { createConnection } from 'node:net';
import { env } from '@taxtronik/config';
import { MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import { connection, type VirusScanJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

async function scanWithClamAV(data: Buffer): Promise<'CLEAN' | 'INFECTED' | 'ERROR'> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT }, () => {
      socket.write(Buffer.from('zINSTREAM\0'));
      const chunkSize = 4096;
      for (let off = 0; off < data.length; off += chunkSize) {
        const chunk = data.subarray(off, off + chunkSize);
        const lenBuf = Buffer.allocUnsafe(4);
        lenBuf.writeUInt32BE(chunk.length, 0);
        socket.write(lenBuf);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    let response = '';
    socket.on('data', (d: Buffer) => { response += d.toString('utf8'); });
    socket.on('end', () => {
      const t = response.trim();
      if (t.endsWith('OK')) resolve('CLEAN');
      else if (t.includes('FOUND')) resolve('INFECTED');
      else resolve('ERROR');
    });
    socket.on('error', () => resolve('ERROR'));
    socket.setTimeout(60_000, () => { socket.destroy(); resolve('ERROR'); });
  });
}

export const virusScanWorker = new Worker<VirusScanJob>(
  'virus-scan',
  async (job) => {
    const { tenantId, documentVersionId, bucket, storageKey } = job.data;
    log.info({ tenantId, documentVersionId, bucket, storageKey }, 'virus-scan: start');

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
    // N5: ContentLength-Check + Streaming-Guard (symmetrisch zu service.ts).
    // Verhindert OOM bei riesigem Objekt, wenn z. B. jemand manuell ein Re-Scan-
    // Job für ein großes Backup-Objekt einreiht.
    if (typeof obj.ContentLength === 'number' && obj.ContentLength > MAX_UPLOAD_BYTES) {
      log.warn({ documentVersionId, size: obj.ContentLength }, 'virus-scan: object too large, marking ERROR');
      await prismaOwner.documentVersion.update({
        where: { id: documentVersionId },
        data: { scanStatus: 'ERROR', scanCompletedAt: new Date() },
      });
      return { result: 'ERROR' as const };
    }
    const stream = obj.Body as Readable;
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const c of stream) {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBuffer);
      received += buf.length;
      if (received > MAX_UPLOAD_BYTES) {
        stream.destroy();
        log.warn({ documentVersionId, received }, 'virus-scan: streaming cap exceeded, abort');
        await prismaOwner.documentVersion.update({
          where: { id: documentVersionId },
          data: { scanStatus: 'ERROR', scanCompletedAt: new Date() },
        });
        return { result: 'ERROR' as const };
      }
      chunks.push(buf);
    }
    const data = Buffer.concat(chunks);

    const result = await scanWithClamAV(data);

    // N-4: scanStatus zuerst persistieren — sonst hängt der Job, falls
    // DeleteObject auf einem Object-Lock-COMPLIANCE-Bucket (gobd) mit
    // AccessDenied scheitert. Die DB-Update darf das Scan-Resultat unter
    // KEINEN Umständen verlieren, sonst bleibt das Document forever PENDING
    // und der Commit-Pfad würde es als „noch nicht gescannt" behandeln.
    let finalStatus: string = result;
    if (result === 'INFECTED') {
      try {
        log.warn({ documentVersionId }, 'virus-scan: INFECTED — Datei wird gelöscht');
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
      } catch (err) {
        // Object-Lock-COMPLIANCE-Bucket verbietet Delete bis Retention abläuft.
        // Wir markieren das Dokument als INFECTED_LOCKED — die UI/Ops können
        // den Vorgang dann manuell behandeln (z. B. Bucket-Policy override durch
        // den Custodian, oder Warten bis Retention abläuft).
        finalStatus = 'INFECTED_LOCKED';
        log.error(
          { documentVersionId, bucket, storageKey, err: (err as Error).message },
          'virus-scan: INFECTED, aber Delete am Storage-Bucket fehlgeschlagen — INFECTED_LOCKED',
        );
      }
    }

    await prismaOwner.documentVersion.update({
      where: { id: documentVersionId },
      data: {
        scanStatus: finalStatus,
        scanCompletedAt: new Date(),
      },
    });

    log.info({ documentVersionId, result: finalStatus }, 'virus-scan: done');
    return { result: finalStatus };
  },
  { connection, concurrency: 4 },
);

virusScanWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'virus-scan: failed');
});
