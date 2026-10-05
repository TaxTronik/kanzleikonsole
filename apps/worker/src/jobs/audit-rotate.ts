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
// F-12 (AUDIT-ARCHIVE-001): Scheitert der Stempel, wird das Segment trotzdem
// archiviert, aber mit tsa_status = PENDING. Jeder Lauf stempelt solche
// Segmente nach (STAMPED_LATE), nachdem er Größe, SHA-256 und Kette des
// gesperrten Objekts geprüft hat. Die TSA wählt resolveTsa (tsa-port.ts), wie
// für Tagessiegel und Rolling Anchors.
//
// Konfiguration:
//   - AUDIT_ARCHIVE_BATCH (Default 5000): max. Einträge pro Run + Tenant
//   - AUDIT_ARCHIVE_MIN_AGE_DAYS (Default 90): nur Einträge älter als X Tage
//   - AUDIT_ARCHIVE_MODE (SOFT|HARD, Default SOFT): bei HARD wird DB
//     anschließend bereinigt
//
// Schedule: wöchentlich (siehe scheduler.ts).
// =============================================================================

import { createWorker } from '../worker-factory';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  serializeArchive,
  parseArchive,
  verifyArchiveChain,
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
import { resolveTsa } from '../tsa-port';

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
/** Nachstempel je Tenant und Lauf; ein TSA-Ausfall beendet den Nachstempel sofort. */
const RESTAMP_BATCH = 100;
// § 147 AO: 10 Jahre ab Schluss des Kalenderjahres — siehe gobdRetentionUntil
// im @taxtronik/storage-Paket. Audit-Archive ist GoBD-pflichtig.

interface StoredSegmentExpectation {
  size: number;
  sha256: Buffer;
}

/**
 * AUDIT-ARCHIVE-001: existence alone never proves that recovery found our
 * segment. Streams the object with a size bound and compares size and SHA-256;
 * with `keepBytes` the verified bytes are returned for a chain check.
 */
async function readVerifiedArchive(
  storageKey: string,
  expected: StoredSegmentExpectation,
  keepBytes: boolean,
): Promise<Buffer | null> {
  const object = await s3.send(new GetObjectCommand({ Bucket: ARCHIVE_BUCKET, Key: storageKey }));
  const body = object.Body as Readable;
  try {
    if (object.ContentLength !== expected.size) {
      throw new Error('AUDIT_ARCHIVE_RECOVERY_MISMATCH: Gespeicherte Segmentgröße weicht ab.');
    }
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > expected.size) {
        throw new Error('AUDIT_ARCHIVE_RECOVERY_MISMATCH: Gespeichertes Segment ist zu groß.');
      }
      hash.update(chunk);
      if (keepBytes) chunks.push(Buffer.from(chunk));
    }
    if (size !== expected.size || !hash.digest().equals(expected.sha256)) {
      throw new Error('AUDIT_ARCHIVE_RECOVERY_MISMATCH: Gespeicherter Segmentinhalt weicht ab.');
    }
    return keepBytes ? Buffer.concat(chunks) : null;
  } finally {
    body?.destroy();
  }
}

interface ArchiveStamp {
  blob: Buffer;
  serial: string | null;
}

/**
 * Externer RFC-3161-Stempel über den Datei-Hash. Gespeichert wird nur eine
 * Antwort, die gegen diesen Hash und die konfigurierten Trust-Roots verifiziert
 * ist; ohne erreichbare externe TSA (auch Dev-Self-Timestamp) gibt es keinen
 * Stempel — ehrlich „nicht extern gestempelt" statt eines vorgetäuschten.
 */
async function stampArchiveHash(tenantId: string, hash: Buffer): Promise<ArchiveStamp | null> {
  let tsaUrl: string | null = null;
  try {
    const tsa = await resolveTsa(tenantId, 'stamp');
    tsaUrl = tsa.url;
    if (tsa.port.mode !== 'rfc3161') {
      throw new Error('Keine externe RFC-3161-TSA erreichbar (Self-Timestamp).');
    }
    const stamp = await tsa.port.timestamp(hash);
    const response = stamp.tsaResponseBlob ? Buffer.from(stamp.tsaResponseBlob) : null;
    if (!response || !(await tsa.port.verify(hash, response))) {
      throw new Error(
        'TSA-Antwort konnte nicht gegen Datei-Hash und konfigurierte Trust-Roots verifiziert werden.',
      );
    }
    return { blob: response, serial: stamp.tsaSerial };
  } catch (err) {
    log.warn(
      { tenantId, tsaUrl, err: (err as Error).message },
      'audit-rotate: TSA-Stempel fehlgeschlagen — Segment bleibt zum Nachstempeln vorgemerkt',
    );
    return null;
  }
}

/**
 * F-12: stempelt Segmente mit tsa_status = PENDING nach. Vor dem Stempel
 * werden Größe, SHA-256 und Kettenanker des gesperrten Objekts gegen die
 * Archivzeile geprüft, damit der Stempel nur das tatsächlich gespeicherte
 * Segment bezeugt. Weicht das Objekt ab, bleibt das Segment PENDING und der
 * Befund wird gemeldet; ein TSA-Fehler beendet den Nachstempel des Tenants.
 */
async function restampPendingArchives(
  tenantId: string,
): Promise<{ restamped: number; rejected: number }> {
  const pending = await prismaOwner.auditArchive.findMany({
    where: { tenantId, tsaStatus: 'PENDING' },
    orderBy: { fromAuditId: 'asc' },
    take: RESTAMP_BATCH,
    select: {
      id: true,
      fromAuditId: true,
      toAuditId: true,
      storageKey: true,
      fileSha256: true,
      fileSizeBytes: true,
      firstPrevHash: true,
      lastThisHash: true,
    },
  });
  let restamped = 0;
  let rejected = 0;
  for (const segment of pending) {
    const fileSha256 = Buffer.from(segment.fileSha256);
    try {
      const bytes = await readVerifiedArchive(
        segment.storageKey,
        { size: Number(segment.fileSizeBytes), sha256: fileSha256 },
        true,
      );
      const check = verifyArchiveChain(parseArchive(bytes!), {
        firstPrevHash: Buffer.from(segment.firstPrevHash),
        lastThisHash: Buffer.from(segment.lastThisHash),
      });
      if (!check.ok) {
        throw new Error(
          `AUDIT_ARCHIVE_CHAIN_INVALID: ${check.reason ?? 'Segmentprüfung fehlgeschlagen'}`,
        );
      }
    } catch (err) {
      rejected += 1;
      log.error(
        {
          tenantId,
          archiveId: String(segment.id),
          from: String(segment.fromAuditId),
          to: String(segment.toAuditId),
          storageKey: segment.storageKey,
          err: (err as Error).message,
        },
        'audit-rotate: Archivsegment weicht vom Archiveintrag ab — kein Nachstempel',
      );
      continue;
    }

    const stamp = await stampArchiveHash(tenantId, fileSha256);
    if (!stamp) break;
    // Der DB-Guard erlaubt genau diesen einmaligen Übergang PENDING -> STAMPED_LATE.
    const updated = await prismaOwner.auditArchive.updateMany({
      where: { id: segment.id, tenantId, tsaStatus: 'PENDING' },
      data: {
        tsaResponseBlob: prismaBytes(stamp.blob),
        tsaSerial: stamp.serial,
        tsaStatus: 'STAMPED_LATE',
        tsaStampedAt: new Date(),
      },
    });
    if (updated.count === 1) {
      restamped += 1;
      log.info(
        { tenantId, archiveId: String(segment.id), storageKey: segment.storageKey },
        'audit-rotate: Archivsegment nachträglich RFC-3161-gestempelt',
      );
    }
  }
  return { restamped, rejected };
}

/**
 * Archiviert für einen Tenant das nächste fällige Segment (höchstens BATCH
 * Einträge) und liefert die Anzahl archivierter Einträge; 0 = nichts fällig.
 */
async function archiveNextSegment(tenantId: string, cutoff: Date): Promise<number> {
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
    return 0;
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
    return 0;
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
  const check = verifyArchiveChain(parseArchive(ser.ndjson), {
    firstPrevHash: ser.firstPrevHash,
    lastThisHash: ser.lastThisHash,
  });
  if (!check.ok) {
    throw new Error(
      `AUDIT_ARCHIVE_CHAIN_INVALID: ${check.reason ?? 'Segmentprüfung fehlgeschlagen'}`,
    );
  }

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
    await readVerifiedArchive(
      storageKey,
      { size: ser.ndjson.length, sha256: ser.fileSha256 },
      false,
    );
    alreadyExists = true;
    log.warn(
      { tenantId, storageKey },
      'audit-rotate: Object existiert bereits — DB-Eintrag wird nachgezogen (Forward-Recovery)',
    );
  } catch (err) {
    // NotFound ist erwartet — alles andere ist ein echter S3-Fehler und propagiert
    const name = (err as Error & { name?: string; $metadata?: { httpStatusCode?: number } }).name;
    const status = (err as Error & { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (name !== 'NotFound' && status !== 404) throw err;
  }

  if (!alreadyExists) {
    await s3.send(
      new PutObjectCommand({
        Bucket: ARCHIVE_BUCKET,
        Key: storageKey,
        IfNoneMatch: '*',
        Body: ser.ndjson,
        ContentLength: ser.ndjson.length,
        ContentType: 'application/x-ndjson',
        ChecksumSHA256: ser.fileSha256.toString('base64'),
        ObjectLockMode: 'COMPLIANCE' as const,
        ObjectLockRetainUntilDate: retentionUntil,
      }),
    );
  }

  // 4. RFC-3161-Stempel (F3/F-12). Gleiche TSA-Auswahl wie Tagessiegel und
  // Rolling Anchors. Ohne Stempel: NULL + PENDING — ehrlich „noch nicht
  // extern gestempelt", ein späterer Lauf stempelt nach.
  const stamp = await stampArchiveHash(tenantId, ser.fileSha256);

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
      tsaResponseBlob: stamp ? prismaBytes(stamp.blob) : null,
      tsaSerial: stamp?.serial ?? null,
      tsaStatus: stamp ? 'STAMPED' : 'PENDING',
      tsaStampedAt: stamp ? new Date() : null,
      mode: MODE,
    },
  });

  // 6. HARD-Mode (DB-Cleanup) ist im MVP nicht implementiert — siehe
  //    MODE-Normalisierung oben (RF-13). totalDeleted bleibt ehrlich 0.

  log.info(
    {
      tenantId,
      from: String(ser.fromAuditId),
      to: String(ser.toAuditId),
      count: ser.entryCount,
      storageKey,
      tsaStatus: stamp ? 'STAMPED' : 'PENDING',
    },
    'audit-rotate: Segment archiviert',
  );
  return ser.entryCount;
}

export const auditRotateWorker = createWorker<ChecksJob>(
  JOB_QUEUES.auditRotate.name,
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    let totalArchived = 0;
    let restamped = 0;
    let restampRejected = 0;
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
      // Fehlende RFC-3161-Stempel früherer Segmente nachholen (F-12).
      const restamp = await restampPendingArchives(tenantId);
      restamped += restamp.restamped;
      restampRejected += restamp.rejected;
      totalArchived += await archiveNextSegment(tenantId, cutoff);
    }

    log.info({ totalArchived, totalDeleted, restamped, restampRejected }, 'audit-rotate: done');
    return { totalArchived, totalDeleted, restamped, restampRejected };
  },
  { connection, concurrency: 1 },
);

auditRotateWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'audit-rotate: failed');
});
