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
// P-17: Ein Lauf archiviert je Tenant Segment um Segment, bis nichts mehr
// fällig ist oder das Zeitbudget (run-budget.ts, ~10 min) erreicht ist; das
// Nachstempeln läuft ebenso seitenweise. Scheitert der Stempel, bleiben die
// weiteren Segmente des Tenants in diesem Lauf ohne neuen TSA-Versuch PENDING.
// Das Job-Ergebnis meldet den Rückstand (`backlog`: fällige, noch nicht
// archivierte Einträge) und die noch ungestempelten Segmente (`pendingStamps`).
// B14: Ein vollständiger Lauf (ohne tenantId) übergibt den Rückstand je Tenant
// samt Fälligkeit des ältesten offenen Eintrags an maintenance-backlog.ts —
// Health-Kennzahl `backlogStatus` und Alarm ab der dort definierten Schwelle.
//
// Konfiguration:
//   - AUDIT_ARCHIVE_BATCH (Default 5000): max. Einträge pro Segment
//   - AUDIT_ARCHIVE_MIN_AGE_DAYS (Default 90): nur Einträge älter als X Tage
//   - AUDIT_ARCHIVE_MODE (SOFT|HARD, Default SOFT): bei HARD wird DB
//     anschließend bereinigt
//
// Schedule: wöchentlich (siehe scheduler.ts).
// =============================================================================

import { createWorker } from '../worker-factory';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Worker } from 'bullmq';
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
import { isWorkerClosing, startRunBudget, type RunBudget } from '../run-budget';
import {
  recordMaintenanceBacklog,
  type MaintenanceBacklogStatus,
  type TenantBacklog,
} from '../maintenance-backlog';

const DAY_MS = 24 * 60 * 60 * 1000;
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
/** Seitengröße beim Nachstempeln; ein TSA-Ausfall beendet den Nachstempel sofort. */
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

async function loadPendingSegments(tenantId: string, afterFromAuditId: bigint | null) {
  return prismaOwner.auditArchive.findMany({
    where: {
      tenantId,
      tsaStatus: 'PENDING',
      ...(afterFromAuditId === null ? {} : { fromAuditId: { gt: afterFromAuditId } }),
    },
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
}

type PendingSegment = Awaited<ReturnType<typeof loadPendingSegments>>[number];

/**
 * F-12: stempelt ein Segment mit tsa_status = PENDING nach. Vor dem Stempel
 * werden Größe, SHA-256 und Kettenanker des gesperrten Objekts gegen die
 * Archivzeile geprüft, damit der Stempel nur das tatsächlich gespeicherte
 * Segment bezeugt. Weicht das Objekt ab, bleibt das Segment PENDING und der
 * Befund wird gemeldet.
 */
async function restampSegment(
  tenantId: string,
  segment: PendingSegment,
): Promise<'restamped' | 'rejected' | 'tsa-failed' | 'unchanged'> {
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
    return 'rejected';
  }

  const stamp = await stampArchiveHash(tenantId, fileSha256);
  if (!stamp) return 'tsa-failed';
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
  if (updated.count !== 1) return 'unchanged';
  log.info(
    { tenantId, archiveId: String(segment.id), storageKey: segment.storageKey },
    'audit-rotate: Archivsegment nachträglich RFC-3161-gestempelt',
  );
  return 'restamped';
}

/**
 * Stempelt die PENDING-Segmente eines Tenants seitenweise nach (P-17: bis
 * keines mehr offen ist oder das Budget endet). Abweichende Segmente bleiben
 * PENDING und werden übersprungen; ein TSA-Fehler beendet den Nachstempel.
 */
async function restampPendingArchives(
  tenantId: string,
  budget: RunBudget,
): Promise<{ restamped: number; rejected: number }> {
  const counts = { restamped: 0, rejected: 0 };
  let after: bigint | null = null;
  for (;;) {
    const pending = await loadPendingSegments(tenantId, after);
    for (const segment of pending) {
      if (budget.exhausted()) return counts;
      after = segment.fromAuditId;
      const outcome = await restampSegment(tenantId, segment);
      if (outcome === 'tsa-failed') return counts;
      if (outcome === 'restamped') counts.restamped += 1;
      if (outcome === 'rejected') counts.rejected += 1;
    }
    if (pending.length < RESTAMP_BATCH) return counts;
  }
}

/**
 * Fälliger Bereich eines Tenants: nach dem zuletzt archivierten Eintrag bis
 * zur größten id mit occurredAt <= cutoff; null = nichts fällig.
 */
async function dueRange(
  tenantId: string,
  cutoff: Date,
): Promise<{ sinceId: bigint; maxId: bigint } | null> {
  // 1. Letzten archivierten Audit-ID finden
  const lastArchive = await prismaOwner.auditArchive.findFirst({
    where: { tenantId },
    orderBy: { toAuditId: 'desc' },
    select: { toAuditId: true },
  });
  const sinceId = lastArchive?.toAuditId ?? BigInt(0);

  // 2. Fällige Einträge (alt genug + nicht-archiviert). RF-11: erst die
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
  return maxId === null || maxId <= sinceId ? null : { sinceId, maxId };
}

/**
 * P-17/B14: Rückstand eines Tenants — fällige, noch nicht archivierte Einträge
 * und die Fälligkeit des ältesten davon (erster Eintrag des Bereichs plus
 * MIN_AGE_DAYS; die id folgt der Schreibreihenfolge).
 */
async function measureDueEntries(tenantId: string, cutoff: Date): Promise<TenantBacklog> {
  const range = await dueRange(tenantId, cutoff);
  if (!range) return { tenantId, count: 0, oldestDueAt: null };
  const where = { tenantId, id: { gt: range.sinceId, lte: range.maxId } };
  const [count, oldest] = await Promise.all([
    prismaOwner.auditLog.count({ where }),
    prismaOwner.auditLog.findFirst({
      where,
      orderBy: { id: 'asc' },
      select: { occurredAt: true },
    }),
  ]);
  const oldestDueAt = oldest ? new Date(oldest.occurredAt.getTime() + MIN_AGE_DAYS * DAY_MS) : null;
  return { tenantId, count, oldestDueAt };
}

type SerializedArchive = ReturnType<typeof serializeArchive>;

/**
 * Upload in den Object-Store mit Object-Lock COMPLIANCE.
 *
 * N-8: Idempotenz-Check. S3-PUT + DB-INSERT sind nicht atomar — ein
 * Crash zwischen den Schritten würde eine 10 Jahre unlöschbare Geister-
 * NDJSON im COMPLIANCE-Bucket lassen, und beim nächsten Run würde dieselbe
 * Datei nochmal hochgeladen (sinceId blieb gleich, weil auditArchive.create
 * nie lief). HeadObject + Skip macht die Sequenz forward-recovery-safe.
 */
async function uploadSegment(
  tenantId: string,
  storageKey: string,
  ser: SerializedArchive,
): Promise<void> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: ARCHIVE_BUCKET, Key: storageKey }));
    await readVerifiedArchive(
      storageKey,
      { size: ser.ndjson.length, sha256: ser.fileSha256 },
      false,
    );
    log.warn(
      { tenantId, storageKey },
      'audit-rotate: Object existiert bereits — DB-Eintrag wird nachgezogen (Forward-Recovery)',
    );
    return;
  } catch (err) {
    // NotFound ist erwartet — alles andere ist ein echter S3-Fehler und propagiert
    const name = (err as Error & { name?: string; $metadata?: { httpStatusCode?: number } }).name;
    const status = (err as Error & { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (name !== 'NotFound' && status !== 404) throw err;
  }

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
      ObjectLockRetainUntilDate: gobdRetentionUntil(),
    }),
  );
}

interface ArchivedSegment {
  /** Archivierte Einträge; 0 = nichts fällig. */
  entries: number;
  stamped: boolean;
}

/**
 * Archiviert für einen Tenant das nächste fällige Segment (höchstens BATCH
 * Einträge). Mit `tryStamp = false` entsteht das Segment ohne TSA-Versuch als
 * PENDING (P-17: die TSA ist in diesem Lauf bereits gescheitert).
 */
async function archiveNextSegment(
  tenantId: string,
  cutoff: Date,
  tryStamp: boolean,
): Promise<ArchivedSegment> {
  const range = await dueRange(tenantId, cutoff);
  const rows = range
    ? await prismaOwner.auditLog.findMany({
        where: {
          tenantId,
          id: { gt: range.sinceId, lte: range.maxId },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
      })
    : [];
  if (rows.length === 0) {
    log.debug({ tenantId }, 'audit-rotate: nichts zu archivieren');
    return { entries: 0, stamped: false };
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

  // 3. Upload in Object-Store mit Object-Lock COMPLIANCE (inkl. N-8-Recovery)
  const yyyy = ser.fromOccurredAt.getUTCFullYear();
  const mm = String(ser.fromOccurredAt.getUTCMonth() + 1).padStart(2, '0');
  const storageKey = `tenants/${tenantId}/audit-archive/${yyyy}/${mm}/${ser.fromAuditId}-${ser.toAuditId}.ndjson`;
  await uploadSegment(tenantId, storageKey, ser);

  // 4. RFC-3161-Stempel (F3/F-12). Gleiche TSA-Auswahl wie Tagessiegel und
  // Rolling Anchors. Ohne Stempel: NULL + PENDING — ehrlich „noch nicht
  // extern gestempelt", ein späterer Lauf stempelt nach.
  const stamp = tryStamp ? await stampArchiveHash(tenantId, ser.fileSha256) : null;

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
  return { entries: ser.entryCount, stamped: stamp !== null };
}

/**
 * P-17: archiviert Segment um Segment, bis nichts mehr fällig ist oder das
 * Budget endet. Ein Segment mit weniger als BATCH Einträgen hat den fälligen
 * Bereich vollständig erfasst. Nach dem ersten gescheiterten Stempel entstehen
 * die weiteren Segmente dieses Laufs ohne neuen TSA-Versuch als PENDING.
 */
async function archiveDueSegments(
  tenantId: string,
  cutoff: Date,
  budget: RunBudget,
): Promise<{ entries: number; segments: number; complete: boolean }> {
  const result = { entries: 0, segments: 0, complete: false };
  let tryStamp = true;
  while (!budget.exhausted()) {
    const segment = await archiveNextSegment(tenantId, cutoff, tryStamp);
    if (segment.entries === 0) return { ...result, complete: true };
    result.entries += segment.entries;
    result.segments += 1;
    if (segment.entries < BATCH) return { ...result, complete: true };
    tryStamp = segment.stamped;
  }
  return result;
}

export interface AuditRotateResult {
  totalArchived: number;
  /** Bleibt 0, solange HARD nicht implementiert ist (RF-13). */
  totalDeleted: number;
  restamped: number;
  restampRejected: number;
  /** P-17: in diesem Lauf archivierte Segmente. */
  segments: number;
  /** P-17: fällige, noch nicht archivierte Audit-Einträge nach dem Lauf. */
  backlog: number;
  /** F-12/P-17: Segmente, die noch auf den RFC-3161-Stempel warten. */
  pendingStamps: number;
  /** P-17: der Lauf endete am Zeitbudget oder wegen Herunterfahrens. */
  budgetExhausted: boolean;
  /**
   * B14: Health-Kennzahl des Rückstands (Anzahl, ältester offener Eintrag,
   * Läufe in Folge, Alarm). null bei einem auf einen Tenant begrenzten Lauf:
   * Kennzahl und Alarm beruhen nur auf vollständigen Läufen.
   */
  backlogStatus: MaintenanceBacklogStatus | null;
}

export async function runAuditRotate(
  data: ChecksJob,
  budget: RunBudget = startRunBudget(),
): Promise<AuditRotateResult> {
  const tenantIds = data.tenantId
    ? [data.tenantId]
    : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

  let totalArchived = 0;
  let segments = 0;
  let restamped = 0;
  let restampRejected = 0;
  // Bleibt 0, solange HARD nicht implementiert ist (RF-13) — Feld im
  // Job-Result beibehalten, damit Monitoring/Tests stabil bleiben.
  const totalDeleted = 0;
  const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000);
  const unfinished: string[] = [];

  if (MODE_RAW === 'HARD') {
    log.warn(
      'audit-rotate: AUDIT_ARCHIVE_MODE=HARD angefordert, aber DB-Cleanup ist im MVP nicht implementiert (Insert-Only-Trigger blockiert DELETE) — Archiv-Einträge werden ehrlich als SOFT persistiert.',
    );
  }

  for (const tenantId of tenantIds) {
    if (budget.exhausted()) {
      unfinished.push(tenantId);
      continue;
    }
    // Fehlende RFC-3161-Stempel früherer Segmente nachholen (F-12).
    const restamp = await restampPendingArchives(tenantId, budget);
    restamped += restamp.restamped;
    restampRejected += restamp.rejected;
    const archived = await archiveDueSegments(tenantId, cutoff, budget);
    totalArchived += archived.entries;
    segments += archived.segments;
    if (!archived.complete) unfinished.push(tenantId);
  }

  // P-17: Rückstand nur für Tenants messen, die der Lauf nicht abschließen konnte;
  // die übrigen haben mit diesem Stichtag nichts Fälliges mehr.
  const tenantBacklogs: TenantBacklog[] = [];
  for (const tenantId of unfinished) tenantBacklogs.push(await measureDueEntries(tenantId, cutoff));
  const backlog = tenantBacklogs.reduce((sum, tenant) => sum + tenant.count, 0);
  const pendingStamps = await prismaOwner.auditArchive.count({
    where: { tsaStatus: 'PENDING', ...(data.tenantId ? { tenantId: data.tenantId } : {}) },
  });
  const result: AuditRotateResult = {
    totalArchived,
    totalDeleted,
    restamped,
    restampRejected,
    segments,
    backlog,
    pendingStamps,
    budgetExhausted: unfinished.length > 0,
    backlogStatus: data.tenantId
      ? null
      : await recordMaintenanceBacklog('auditRotate', tenantBacklogs),
  };
  if (backlog > 0) {
    log.warn(
      { backlog, unfinishedTenants: unfinished.length },
      'audit-rotate: Zeitbudget erreicht — Rückstand bleibt für den nächsten Lauf',
    );
  }
  log.info(result, 'audit-rotate: done');
  return result;
}

// Typ explizit: der Processor liest `closing` des eigenen Workers (P-17).
export const auditRotateWorker: Worker<ChecksJob> = createWorker<ChecksJob>(
  JOB_QUEUES.auditRotate.name,
  async (job) =>
    runAuditRotate(job.data, startRunBudget({ stop: () => isWorkerClosing(auditRotateWorker) })),
  { connection, concurrency: 1 },
);
