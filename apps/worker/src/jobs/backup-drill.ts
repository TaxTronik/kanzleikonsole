// =============================================================================
// backup-drill-Worker — beweisbarer Restore-Test (Art. 32 Abs. 1 lit. d DSGVO,
// GoBD: „regelmäßige Überprüfung der Wirksamkeit der Maßnahmen").
//
// Monatlich: das letzte ERFOLGREICHE Backup aus dem Object-Store wird in eine
// Wegwerf-DB (`taxtronik_drill`) eingespielt (pg_restore mit exakt den Flags
// des Produktiv-Restores, restore.ts) und dort pro Tenant die Audit-Hash-Chain
// verifiziert. Damit ist nicht nur „Backup existiert", sondern „Backup ist
// wiederherstellbar UND inhaltlich intakt" nachgewiesen — verankert als
// Audit-Event (backup.drill.*) in der Hash-Chain der PRODUKTIV-DB.
//
// Ergebnis pro Tenant: tenant_setting `backup_drill_result` (Admin-Seite liest
// nur dieses Ergebnis). Fehlschlag → Notification an ADMIN/PARTNER
// (SYSTEM_BACKUP_FAILED, dedupliziert via upsertNotification).
//
// Technik:
//   - pg_restore kommt aus dem Worker-Image (postgresql18-client, Dockerfile.
//     worker) — Client-Major MUSS >= Server-Major sein.
//   - Der Dump wird aus S3 DIREKT in pg_restore-stdin gestreamt: /tmp ist ein
//     64-MB-tmpfs (read_only-Container), reale Dumps sind größer. Custom-
//     Format aus stdin ist ohne -j (parallel) erlaubt.
//   - SHA-256 wird beim Streamen mitgerechnet und gegen BackupRecord.sha256
//     geprüft — ein korruptes Backup-Objekt fällt im Drill auf, nicht erst
//     im Ernstfall.
//   - DROP/CREATE DATABASE laufen als Owner-Rolle über prismaOwner
//     ($executeRawUnsafe, statische Statements — kein User-Input im SQL).
// =============================================================================

import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Worker } from 'bullmq';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { env } from '@taxtronik/config';
import { createPostgresAdapter } from '@taxtronik/db/prisma-adapter';
import {
  EvidenceService,
  LocalTimestampAdapter,
  Rfc3161HttpAdapter,
  BACKUP_DRILL_RESULT_SETTING_KEY,
  type PersistedDrillResult,
} from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { pgConnArgs } from '../pg-conn';
import { withWorkerTenantContext } from '../tenant-context';
import { upsertNotification } from '../notify';
import { log } from '../logger';

const DRILL_DB = 'taxtronik_drill';

// Chain-Walk hasht jede audit_log-Zeile — gleiches großzügiges Timeout wie
// audit-verify-check (P-1).
const VERIFY_TX_OPTIONS = { timeout: 120_000, maxWait: 5_000 } as const;

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

// Wie audit-verify-check: verify() braucht nur den Stamp-Validator.
const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? new Rfc3161HttpAdapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();
const evidenceService = new EvidenceService(timestampPort);

/** Gleiche Verbindung, anderer DB-Name (Query — z. B. ?schema= — bleibt erhalten). */
export function withDbName(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Entscheidet das Drill-Ergebnis für einen Tenant, der im Backup FEHLT:
 * jünger als das Backup → erwartbar (ok), älter → das Backup ist lückenhaft.
 * Exportiert für den Unit-Test.
 */
export function missingTenantResult(
  tenantCreatedAt: Date,
  backupFinishedAt: Date | null,
): { ok: boolean; error: string | null } {
  if (backupFinishedAt && tenantCreatedAt > backupFinishedAt) {
    return { ok: true, error: null }; // Tenant ist neuer als das Backup — beim nächsten Drill dabei.
  }
  return { ok: false, error: 'Tenant fehlt im wiederhergestellten Backup (Backup lückenhaft?)' };
}

async function recreateDrillDb(): Promise<void> {
  await prismaOwner.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)`);
  await prismaOwner.$executeRawUnsafe(`CREATE DATABASE ${DRILL_DB}`);
}

async function dropDrillDb(): Promise<void> {
  await prismaOwner
    .$executeRawUnsafe(`DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)`)
    .catch((e: unknown) =>
      log.warn({ err: (e as Error).message }, 'backup-drill: drop drill db failed'),
    );
}

/** S3-Objekt → pg_restore-stdin streamen; SHA-256 nebenbei gegen den Record prüfen. */
async function restoreIntoDrill(
  bucket: string,
  key: string,
  expectedSha: Uint8Array | null,
): Promise<void> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body as Readable;

  const conn = pgConnArgs(withDbName(env.DATABASE_URL, DRILL_DB));
  const pgRestorePath = process.env['PG_RESTORE_PATH'] ?? 'pg_restore';
  const child = spawn(
    pgRestorePath,
    // Identische Flags wie der Produktiv-Restore (restore.ts) — nur ohne
    // Datei-Argument: ohne Pfad liest pg_restore von stdin.
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', ...conn.args],
    { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, ...conn.env } },
  );
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  const exit = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));

  const hash = createHash('sha256');
  body.on('data', (c: Buffer) => hash.update(c));
  try {
    await pipeline(body, child.stdin);
  } catch {
    // EPIPE, wenn pg_restore vorzeitig stirbt — der Exit-Code unten trägt die
    // eigentliche Fehlermeldung (stderr).
  }
  const code = await exit;
  if (code !== 0) throw new Error(`pg_restore exit ${code}: ${stderr.slice(0, 1500)}`);

  if (expectedSha && expectedSha.length === 32) {
    const got = hash.digest();
    if (!timingSafeEqual(got, Buffer.from(expectedSha))) {
      throw new Error('SHA-256 des Dumps weicht vom BackupRecord ab — Backup-Objekt beschädigt?');
    }
  }
}

/** Ergebnis persistieren + in der Produktiv-Chain verankern + ggf. alarmieren. */
async function persistTenantResult(
  tenantId: string,
  result: PersistedDrillResult,
): Promise<void> {
  await withWorkerTenantContext(tenantId, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: BACKUP_DRILL_RESULT_SETTING_KEY } },
      create: { tenantId, key: BACKUP_DRILL_RESULT_SETTING_KEY, value: result as object },
      update: { value: result as object },
    });
    // GoBD-/DSGVO-Beweiswert: der Drill ist erst „durchgeführt", wenn er in
    // der (produktiven) Audit-Hash-Chain steht — Erfolg UND Fehlschlag.
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'SYSTEM',
      actorId: null,
      action: result.ok ? 'backup.drill.completed' : 'backup.drill.failed',
      resourceType: 'backup',
      resourceId: result.backupKey,
      after: { ...result },
    });
  });

  if (!result.ok) {
    const admins = await prismaOwner.staffUser.findMany({
      where: { tenantId, active: true, roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } } },
      select: { id: true },
    });
    for (const a of admins) {
      await upsertNotification(tenantId, a.id, {
        kind: 'SYSTEM_BACKUP_FAILED',
        title: '⚠ Restore-Test fehlgeschlagen',
        body: result.error ?? 'Der monatliche Backup-Wiederherstellungstest ist fehlgeschlagen.',
        href: '/staff/admin',
        resourceType: 'backup_drill',
        resourceId: result.backupKey ?? 'none',
      });
    }
  }
}

async function runDrill(): Promise<{ ok: boolean; tenants: number }> {
  const checkedAt = new Date().toISOString();
  const tenants = await prismaOwner.tenant.findMany({ select: { id: true, createdAt: true } });

  const latest = await prismaOwner.backupRecord.findFirst({
    where: { status: 'SUCCESS', key: { not: null }, bucket: { not: null } },
    orderBy: { finishedAt: 'desc' },
  });
  if (!latest?.key || !latest.bucket) {
    const result: PersistedDrillResult = {
      checkedAt,
      ok: false,
      backupKey: null,
      backupFinishedAt: null,
      auditChecked: 0,
      error: 'Kein erfolgreiches Backup vorhanden — Restore-Test nicht möglich.',
    };
    for (const t of tenants) await persistTenantResult(t.id, result);
    return { ok: false, tenants: tenants.length };
  }

  const base = {
    backupKey: latest.key,
    backupFinishedAt: latest.finishedAt?.toISOString() ?? null,
  };

  try {
    await recreateDrillDb();
    await restoreIntoDrill(latest.bucket, latest.key, latest.sha256 ?? null);
  } catch (err) {
    const result: PersistedDrillResult = {
      checkedAt, ...base, ok: false, auditChecked: 0,
      error: `Restore fehlgeschlagen: ${(err as Error).message}`,
    };
    for (const t of tenants) await persistTenantResult(t.id, result);
    await dropDrillDb();
    return { ok: false, tenants: tenants.length };
  }

  // Verifikation auf der WIEDERHERGESTELLTEN DB (eigener Prisma-Client).
  const drillPrisma = new PrismaClient({
    adapter: createPostgresAdapter(withDbName(env.DATABASE_URL, DRILL_DB)),
  });
  let allOk = true;
  try {
    for (const t of tenants) {
      let result: PersistedDrillResult;
      try {
        const inDrill = await drillPrisma.tenant.findUnique({ where: { id: t.id }, select: { id: true } });
        if (!inDrill) {
          const missing = missingTenantResult(t.createdAt, latest.finishedAt);
          result = { checkedAt, ...base, ok: missing.ok, auditChecked: 0, error: missing.error };
        } else {
          const r = await drillPrisma.$transaction(
            // TSA-Policy prüft audit-verify-check täglich auf der Produktiv-DB;
            // der Drill beweist Wiederherstellbarkeit + Chain-Integrität.
            (tx) => evidenceService.verifyChain(tx, t.id, { requireExternalTsa: false }),
            VERIFY_TX_OPTIONS,
          );
          result = {
            checkedAt, ...base, ok: r.ok, auditChecked: r.checked,
            error: r.ok ? null : `Audit-Hash-Chain auf der wiederhergestellten DB gebrochen${r.firstBreak ? ` (ab Audit-ID ${r.firstBreak.auditId})` : ''}`,
          };
        }
      } catch (err) {
        result = {
          checkedAt, ...base, ok: false, auditChecked: 0,
          error: `Drill-Verifikation fehlgeschlagen: ${(err as Error).message}`,
        };
      }
      if (!result.ok) allOk = false;
      await persistTenantResult(t.id, result);
    }
  } finally {
    await drillPrisma.$disconnect();
    await dropDrillDb();
  }
  return { ok: allOk, tenants: tenants.length };
}

export const backupDrillWorker = new Worker<ChecksJob>(
  'backup-drill',
  async () => {
    const r = await runDrill();
    log.info(r, 'backup-drill: done');
    return r;
  },
  { connection, concurrency: 1 },
);

backupDrillWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'backup-drill: failed');
});
