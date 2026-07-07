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
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  Rfc3161HttpAdapter,
  resolveTsaUrl,
  serializeArchive,
  type ArchiveAuditRow,
} from '@taxtronik/evidence';
import { env } from '@taxtronik/config';
// RF-11: gemeinsamer S3-Client + Bucket aus @taxtronik/storage/@taxtronik/config
// statt eigenem Client mit ''-Credential-Fallbacks (lief sonst mit leeren Keys
// einfach los und scheiterte erst am Request).
import { gobdRetentionUntil, s3 } from '@taxtronik/storage';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { prismaBytes } from '../pg-conn';
import { assertPublicHost } from '../http/ssrf-guard';


const BATCH = Number(process.env['AUDIT_ARCHIVE_BATCH'] ?? '5000');
const MIN_AGE_DAYS = Number(process.env['AUDIT_ARCHIVE_MIN_AGE_DAYS'] ?? '90');
const MODE_RAW = (process.env['AUDIT_ARCHIVE_MODE'] ?? 'SOFT') as 'SOFT' | 'HARD';
// RF-13: HARD (DB-Cleanup nach Archivierung) ist im MVP nicht implementiert —
// der Insert-Only-Trigger auf audit_log blockiert DELETEs (bräuchte eine
// SECURITY-DEFINER-Funktion, siehe IDEAS.md). Vorher wurde bei
// AUDIT_ARCHIVE_MODE=HARD trotzdem mode='HARD' in audit_archive persistiert —
// ein irreführender Nachweis („Einträge wurden aus der DB entfernt", obwohl
// nichts gelöscht wurde). Beim Config-Lesen ehrlich auf SOFT normalisieren,
// bis HARD tatsächlich existiert; der Warn-Hinweis kommt pro Lauf (unten).
const MODE: 'SOFT' = MODE_RAW === 'HARD' ? 'SOFT' : MODE_RAW;
const ARCHIVE_BUCKET = env.S3_BUCKET_GOBD;
// § 147 AO: 10 Jahre ab Schluss des Kalenderjahres — siehe gobdRetentionUntil
// im @taxtronik/storage-Paket. Audit-Archive ist GoBD-pflichtig.

export const auditRotateWorker = new Worker<ChecksJob>(
  'audit-rotate',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    let totalArchived = 0;
    // Bleibt 0, solange HARD nicht implementiert ist (RF-13) — Feld im
    // Job-Result beibehalten, damit Monitoring/Tests stabil bleiben.
    const totalDeleted = 0;
    const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000);

    if (MODE_RAW === 'HARD') {
      log.warn(
        'audit-rotate: AUDIT_ARCHIVE_MODE=HARD angefordert, aber DB-Cleanup ist im MVP nicht implementiert (Insert-Only-Trigger blockiert DELETE) — Archiv-Einträge werden ehrlich als SOFT persistiert.',
      );
    }

    for (const tenantId of tenantIds) {
      // 1. Letzten archivierten Audit-ID finden
      const lastArchive = await prismaOwner.auditArchive.findFirst({
        where: { tenantId },
        orderBy: { toAuditId: 'desc' },
        select: { toAuditId: true },
      });
      const sinceId = lastArchive?.toAuditId ?? BigInt(0);

      // 2. Einträge laden (alt genug + nicht-archiviert). RF-11: erst die
      //    Obergrenze max(id) mit occurredAt <= cutoff bestimmen, dann eine
      //    REINE id-Range ziehen. Die alte Kombi-Selektion `id > sinceId AND
      //    occurredAt <= cutoff` konnte bei nicht-monotoner Uhr (NTP-Rücksprung:
      //    jüngere id mit älterem occurredAt mitten im Bereich, umgekehrt
      //    ausgelassene Zeilen) Lücken ins Segment reißen — die Archiv-Datei
      //    hätte dann einen Hash-Bruch. Eine lückenlose id-Range ist per
      //    Konstruktion kontiguierlich zur Hash-Chain (Verkettung folgt id).
      const boundary = await prismaOwner.auditLog.aggregate({
        _max: { id: true },
        where: { tenantId, occurredAt: { lte: cutoff } },
      });
      const maxId = boundary._max.id;
      if (maxId === null || maxId <= sinceId) {
        log.debug({ tenantId }, 'audit-rotate: nichts zu archivieren');
        continue;
      }
      const rows = await prismaOwner.auditLog.findMany({
        where: {
          tenantId,
          id: { gt: sinceId, lte: maxId },
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
          firstPrevHash: prismaBytes(ser.firstPrevHash),
          lastThisHash: prismaBytes(ser.lastThisHash),
          fileSha256: prismaBytes(ser.fileSha256),
          fileSizeBytes: BigInt(ser.ndjson.length),
          storageBucket: ARCHIVE_BUCKET,
          storageKey,
          tsaResponseBlob: tsaResponseBlob ? prismaBytes(tsaResponseBlob) : null,
          mode: MODE,
        },
      });
      totalArchived += ser.entryCount;

      // 6. HARD-Mode (DB-Cleanup) ist im MVP nicht implementiert — siehe
      //    MODE-Normalisierung oben (RF-13). totalDeleted bleibt ehrlich 0.

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
