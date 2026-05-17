// =============================================================================
// audit-rotate-Worker
//
// Rotiert das audit_log segmentweise im Object-Store-Dateien („Kassenbon-Abriss"):
//
//   1. Lade die nächsten N Einträge nach dem letzten archivierten ID
//      (oder ab Genesis, wenn noch nie archiviert wurde)
//   2. Serialisiere als deterministisches NDJSON
//   3. SHA-256 + RFC-3161-Stempel über die Datei
//   4. Upload zum Object-Store mit Object-Lock COMPLIANCE (10 Jahre)
//   5. Insert in `audit_archive` mit Ankerwerten + Datei-Referenz
//   6. (Optional Modus HARD): Lösche die archivierten Audit-Einträge aus
//      audit_log — der nächste Eintrag verkettet sich automatisch korrekt,
//      weil die Hash-Chain pro tenant_id über prev_hash funktioniert
//
// Konfiguration:
//   - AUDIT_ARCHIVE_BATCH (Default 5000): max. Einträge pro Run + Tenant
//   - AUDIT_ARCHIVE_MIN_AGE_DAYS (Default 90): nur Einträge älter als X Tage
//   - AUDIT_ARCHIVE_MODE (SOFT|HARD, Default SOFT): bei HARD wird DB
//     anschließend bereinigt
//
// Schedule: wöchentlich (siehe scheduler.ts).
// =============================================================================

import { Worker } from 'bullmq';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  Rfc3161HttpAdapter,
  resolveTsaUrl,
  serializeArchive,
  type ArchiveAuditRow,
} from '@taxtronik/evidence';
import { env } from '@taxtronik/config';
import { gobdRetentionUntil } from '@taxtronik/storage';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { assertPublicHost } from '../http/ssrf-guard';


const s3 = new S3Client({
  endpoint: process.env['S3_ENDPOINT'],
  region: process.env['S3_REGION'] ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env['S3_ACCESS_KEY'] ?? '',
    secretAccessKey: process.env['S3_SECRET_KEY'] ?? '',
  },
  forcePathStyle: true,
});

const BATCH = Number(process.env['AUDIT_ARCHIVE_BATCH'] ?? '5000');
const MIN_AGE_DAYS = Number(process.env['AUDIT_ARCHIVE_MIN_AGE_DAYS'] ?? '90');
const MODE = (process.env['AUDIT_ARCHIVE_MODE'] ?? 'SOFT') as 'SOFT' | 'HARD';
const ARCHIVE_BUCKET = process.env['S3_BUCKET_GOBD'] ?? 'gobd';
// § 147 AO: 10 Jahre ab Schluss des Kalenderjahres — siehe gobdRetentionUntil
// im @taxtronik/storage-Paket. Audit-Archive ist GoBD-pflichtig.

export const auditRotateWorker = new Worker<ChecksJob>(
  'audit-rotate',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    let totalArchived = 0;
    let totalDeleted = 0;
    const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000);

    for (const tenantId of tenantIds) {
      // 1. Letzten archivierten Audit-ID finden
      const lastArchive = await prismaOwner.auditArchive.findFirst({
        where: { tenantId },
        orderBy: { toAuditId: 'desc' },
        select: { toAuditId: true },
      });
      const sinceId = lastArchive?.toAuditId ?? BigInt(0);

      // 2. Einträge laden (alt genug + nicht-archiviert)
      const rows = await prismaOwner.auditLog.findMany({
        where: {
          tenantId,
          id: { gt: sinceId },
          occurredAt: { lte: cutoff },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (rows.length === 0) {
        log.debug({ tenantId }, 'audit-rotate: nichts zu archivieren');
        continue;
      }

      const archiveRows: ArchiveAuditRow[] = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        occurredAt: r.occurredAt,
        actorType: r.actorType,
        actorId: r.actorId,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        before: r.before,
        after: r.after,
        ip: r.ip,
        userAgent: r.userAgent,
        prevHash: Buffer.from(r.prevHash),
        thisHash: Buffer.from(r.thisHash),
      }));

      const ser = serializeArchive(archiveRows);

      // 3. Upload in Object-Store mit Object-Lock COMPLIANCE
      const yyyy = ser.fromOccurredAt.getUTCFullYear();
      const mm = String(ser.fromOccurredAt.getUTCMonth() + 1).padStart(2, '0');
      const storageKey = `tenants/${tenantId}/audit-archive/${yyyy}/${mm}/${ser.fromAuditId}-${ser.toAuditId}.ndjson`;
      const retentionUntil = gobdRetentionUntil();

      // N-8: Idempotenz-Check. S3-PUT + DB-INSERT sind nicht atomar — ein
      // Crash zwischen den Schritten würde eine 10 Jahre unlöschbare Geister-
      // NDJSON im COMPLIANCE-Bucket lassen, und beim nächsten Run würde dieselbe
      // Datei nochmal hochgeladen (sinceId blieb gleich, weil auditArchive.create
      // nie lief). HeadObject + Skip macht die Sequenz forward-recovery-safe.
      let alreadyExists = false;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: ARCHIVE_BUCKET, Key: storageKey }));
        alreadyExists = true;
        log.warn(
          { tenantId, storageKey },
          'audit-rotate: Object existiert bereits — DB-Eintrag wird nachgezogen (Forward-Recovery)',
        );
      } catch (err) {
        // NotFound ist erwartet — alles andere ist ein echter S3-Fehler und propagiert
        const name = (err as Error & { name?: string; $metadata?: { httpStatusCode?: number } }).name;
        const status = (err as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (name !== 'NotFound' && status !== 404) throw err;
      }

      if (!alreadyExists) {
        await s3.send(
          new PutObjectCommand({
            Bucket: ARCHIVE_BUCKET,
            Key: storageKey,
            Body: ser.ndjson,
            ContentLength: ser.ndjson.length,
            ContentType: 'application/x-ndjson',
            ChecksumSHA256: ser.fileSha256.toString('base64'),
            ObjectLockMode: 'COMPLIANCE' as const,
            ObjectLockRetainUntilDate: retentionUntil,
          }),
        );
      }

      // 4. Optionaler RFC-3161-Stempel (F3).
      // Symmetrisch zu evidence-seal.ts: Tenant-spezifische TSA aus
      // tenant_setting bevorzugt, ENV-Fallback. Bei Erfolg: echter
      // RFC-3161-Response-Blob ins Archiv. Bei Fehlschlag oder fehlender
      // Konfiguration: NULL — ehrlich „dieses Segment ist nicht extern
      // gestempelt" statt ein lokaler SHA-256, der einen Stempel vortäuscht.
      let tsaResponseBlob: Buffer | null = null;
      const tsaSetting = await prismaOwner.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: 'evidence.tsa' } },
        select: { value: true },
      });
      let tsaUrl: string | null = null;
      if (tsaSetting) {
        const v = tsaSetting.value as { providerId?: string; customUrl?: string };
        tsaUrl = resolveTsaUrl(v.providerId ?? null, v.customUrl ?? null);
      }
      if (!tsaUrl && env.TIMESTAMP_AUTHORITY_URL) {
        tsaUrl = env.TIMESTAMP_AUTHORITY_URL;
      }
      if (tsaUrl) {
        try {
          await assertPublicHost(tsaUrl);
          const adapter = new Rfc3161HttpAdapter(tsaUrl);
          const stamp = await adapter.timestamp(ser.fileSha256);
          if (stamp.tsaResponseBlob) {
            tsaResponseBlob = Buffer.from(stamp.tsaResponseBlob);
          }
        } catch (err) {
          log.warn(
            { tenantId, tsaUrl, err: (err as Error).message },
            'audit-rotate: TSA-Stempel fehlgeschlagen — Archiv-Eintrag ohne externen Zeitstempel',
          );
        }
      }

      // 5. Audit-Archive-Eintrag
      await prismaOwner.auditArchive.create({
        data: {
          tenantId,
          fromAuditId: ser.fromAuditId,
          toAuditId: ser.toAuditId,
          fromOccurredAt: ser.fromOccurredAt,
          toOccurredAt: ser.toOccurredAt,
          entryCount: ser.entryCount,
          firstPrevHash: ser.firstPrevHash,
          lastThisHash: ser.lastThisHash,
          fileSha256: ser.fileSha256,
          fileSizeBytes: BigInt(ser.ndjson.length),
          storageBucket: ARCHIVE_BUCKET,
          storageKey,
          tsaResponseBlob,
          mode: MODE,
        },
      });
      totalArchived += ser.entryCount;

      // 6. HARD-Mode: archivierte Einträge aus audit_log löschen
      // Achtung: audit_log hat Insert-Only-Trigger. Für HARD-Rotation braucht
      // es eine explizite SECURITY DEFINER-Funktion oder eine kontrollierte
      // Trigger-Aussetzung. Im MVP liefern wir nur SOFT (Datei-Backup) —
      // HARD bleibt als Hook für später (siehe IDEAS.md / Architektur-ADR).
      if (MODE === 'HARD') {
        log.warn(
          { tenantId, count: ser.entryCount },
          'audit-rotate: HARD-Modus angefordert, aber DB-Cleanup ist im MVP nicht implementiert (Trigger blockiert DELETE). Datei wurde geschrieben.',
        );
      }

      log.info(
        { tenantId, from: String(ser.fromAuditId), to: String(ser.toAuditId), count: ser.entryCount, storageKey },
        'audit-rotate: Segment archiviert',
      );
    }

    log.info({ totalArchived, totalDeleted }, 'audit-rotate: done');
    return { totalArchived, totalDeleted };
  },
  { connection, concurrency: 1 },
);

auditRotateWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'audit-rotate: failed');
});
