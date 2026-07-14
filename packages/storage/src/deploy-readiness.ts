// =============================================================================
// Deploy-Readiness-Check (Konfiguration, nicht nur Erreichbarkeit).
//
// `/api/health` (smoke_health im Deploy) prüft nur, OB Postgres/Redis/S3/ClamAV
// ERREICHBAR sind. Diese Prüfung geht eine Ebene tiefer und fängt genau die
// prod-spezifischen KONFIGURATIONS-Fehler, die sonst erst beim Kunden auffallen
// (z. B. der GwG-Upload, der nach einem Deploy still nicht mehr ging):
//
//   1. Alle S3-Buckets existieren (gobd, gwg, general, staff-private, backups).
//   2. Object-Lock folgt exakt der fachlichen Policy: gobd COMPLIANCE/10 Jahre,
//      gwg GOVERNANCE/5 Jahre mit kontrolliertem Bypass nur im bestätigten
//      Vernichtungsworkflow. Jede Abweichung ist ein Retention-Fehler.
//   3. ClamAV akzeptiert Uploads in App-Größe: ein Scan über MAX_UPLOAD_BYTES
//      muss durchlaufen (clamd `StreamMaxLength` >= Cap, N-6) — sonst scheitern
//      Browser-Uploads am konfigurierten 25-MiB-Limit als SCAN_ERROR.
//   4. ClamAV hat Signaturen geladen: der EICAR-Testvirus MUSS als INFECTED
//      erkannt werden — ohne Signaturen liefe jeder Scan „clean" und echte
//      Malware landete im GwG-/GoBD-Store.
//   5. Echter Storage-Roundtrip (put → get → delete) im `general`-Bucket —
//      beweist Schreiben/Lesen/Löschen mit den konfigurierten Credentials.
//
// Read-only bei den geschützten Buckets: Es wird NIE in gobd/gwg geschrieben,
// weil Testobjekte dort eine langfristige Retention erhielten. Der kontrollierte
// GwG-Bypass gehört ausschließlich in den Vernichtungsworkflow; der Roundtrip
// nutzt den lock-freien `general`-Bucket.
// =============================================================================

import { randomUUID } from 'node:crypto';
import {
  HeadBucketCommand,
  GetObjectLockConfigurationCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { env } from '@taxtronik/config';
import { s3 } from './client';
import { fetchObjectBytes, deleteObject, scanBytes, MAX_UPLOAD_BYTES } from './service';
import { evaluateObjectLockConfiguration, type RequiredLockMode } from './object-lock-policy';

/** Standard-EICAR-Testsignatur — von jeder AV-Engine mit Signaturen erkannt. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface ReadinessCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
}

export interface ReadinessReport {
  /** false, sobald mindestens eine Prüfung `fail` ist (WARN kippt es nicht). */
  ok: boolean;
  checks: ReadinessCheck[];
}

export interface ReadinessOptions {
  /**
   * Payload-Größe für den ClamAV-Größen-Scan. Default MAX_UPLOAD_BYTES (25 MiB)
   * — das beweist, dass clamd Uploads in voller App-Größe akzeptiert. In Tests
   * kleiner setzbar (schneller), sollte in CI/Prod aber beim Default bleiben.
   */
  clamavScanBytes?: number;
}

/** Bucket-Name des Backup-Stores (nicht in @taxtronik/config; Ops-verwaltet). */
function backupsBucket(): string {
  return process.env['S3_BUCKET_BACKUPS'] ?? 'backups';
}

async function timed(
  name: string,
  fn: () => Promise<Omit<ReadinessCheck, 'name' | 'durationMs'>>,
): Promise<ReadinessCheck> {
  const start = Date.now();
  try {
    const r = await fn();
    return { name, durationMs: Date.now() - start, ...r };
  } catch (e) {
    return {
      name,
      durationMs: Date.now() - start,
      status: 'fail',
      detail: (e as Error).message,
    };
  }
}

async function checkBucketExists(bucket: string): Promise<ReadinessCheck> {
  return timed(`bucket:${bucket}`, async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return { status: 'ok' as const, detail: 'existiert' };
    } catch (e) {
      return {
        status: 'fail' as const,
        detail: `Bucket fehlt oder nicht erreichbar (${(e as Error).name}: ${(e as Error).message}) — init-storage.sh ausführen bzw. S3-Credentials/Endpoint prüfen.`,
      };
    }
  });
}

async function checkObjectLock(
  bucket: string,
  expected: { mode: RequiredLockMode; years: number },
): Promise<ReadinessCheck> {
  return timed(`object-lock:${bucket}`, async () => {
    try {
      const res = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
      const evaluation = evaluateObjectLockConfiguration(res.ObjectLockConfiguration, expected);
      return {
        status: evaluation.ok ? ('ok' as const) : ('fail' as const),
        detail: evaluation.detail,
      };
    } catch (e) {
      // Ein nicht verifizierbarer Modus darf das Deployment nicht grün
      // verlassen: COMPLIANCE statt GOVERNANCE würde die fristgerechte
      // GwG-Vernichtung technisch blockieren.
      return {
        status: 'fail' as const,
        detail: `Object-Lock-Konfiguration nicht verifizierbar (${(e as Error).message}).`,
      };
    }
  });
}

async function checkClamavSize(sizeBytes: number): Promise<ReadinessCheck> {
  return timed('clamav:size', async () => {
    // All-Zero-Payload in App-Upload-Größe. clamd bricht bei Überschreitung von
    // StreamMaxLength mit ERROR ab → beweist, dass die Deploy-Konfig >= Cap ist.
    const payload = Buffer.alloc(sizeBytes);
    const result = await scanBytes(payload);
    const mib = Math.round(sizeBytes / (1024 * 1024));
    if (result === 'CLEAN') {
      return { status: 'ok', detail: `${mib} MiB akzeptiert (StreamMaxLength >= Upload-Cap)` };
    }
    if (result === 'ERROR') {
      return {
        status: 'fail',
        detail: `Scan über ${mib} MiB fehlgeschlagen — clamd StreamMaxLength < ${mib} MiB? (clamd.conf: StreamMaxLength >= ${mib}M setzen).`,
      };
    }
    // INFECTED bei Nullbytes wäre absurd → als Fehler behandeln.
    return { status: 'fail', detail: `Unerwartetes Scan-Ergebnis: ${result}` };
  });
}

async function checkClamavEicar(): Promise<ReadinessCheck> {
  return timed('clamav:eicar', async () => {
    const result = await scanBytes(Buffer.from(EICAR, 'ascii'));
    if (result === 'INFECTED') {
      return { status: 'ok', detail: 'EICAR erkannt — Signaturen geladen' };
    }
    if (result === 'CLEAN') {
      return {
        status: 'fail',
        detail:
          'EICAR NICHT erkannt — ClamAV hat keine Signaturen geladen (freshclam?). Jeder Scan liefe „clean", Malware käme durch.',
      };
    }
    return { status: 'fail', detail: `EICAR-Scan fehlgeschlagen: ${result}` };
  });
}

async function checkStorageRoundtrip(): Promise<ReadinessCheck> {
  return timed('storage:roundtrip', async () => {
    const bucket = env.S3_BUCKET_GENERAL;
    const key = `_deploy-readiness/${randomUUID()}.bin`;
    const payload = Buffer.from(`deploy-readiness ${new Date().toISOString()}`, 'utf8');
    // Bewusst der lock-FREIE general-Bucket: ein Testobjekt in gobd/gwg wäre
    // jahrelang unlöschbar. Direkter PUT ohne Object-Lock.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: payload,
        ContentLength: payload.length,
        ContentType: 'application/octet-stream',
      }),
    );
    try {
      const read = await fetchObjectBytes(bucket, key);
      if (!read.equals(payload)) {
        return {
          status: 'fail' as const,
          detail: 'Gelesene Bytes weichen von den geschriebenen ab.',
        };
      }
      return { status: 'ok' as const, detail: `put→get→delete ok (${bucket})` };
    } finally {
      await deleteObject(bucket, key).catch(() => {
        // Testobjekt konnte nicht gelöscht werden — nur relevant fürs Aufräumen.
      });
    }
  });
}

/**
 * Führt alle Readiness-Prüfungen aus. `ok` ist false, sobald eine Prüfung
 * `fail` ist. Reihenfolge: erst die günstigen Read-Checks (Buckets, Lock,
 * Roundtrip, EICAR), zuletzt der teure Größen-Scan.
 */
export async function checkDeployReadiness(opts: ReadinessOptions = {}): Promise<ReadinessReport> {
  const appBuckets = [
    env.S3_BUCKET_GOBD,
    env.S3_BUCKET_GWG,
    env.S3_BUCKET_GENERAL,
    env.S3_BUCKET_STAFF_PRIVATE,
    backupsBucket(),
  ];

  const checks: ReadinessCheck[] = [];
  for (const b of appBuckets) checks.push(await checkBucketExists(b));
  checks.push(await checkObjectLock(env.S3_BUCKET_GOBD, { mode: 'COMPLIANCE', years: 10 }));
  checks.push(await checkObjectLock(env.S3_BUCKET_GWG, { mode: 'GOVERNANCE', years: 5 }));
  checks.push(await checkStorageRoundtrip());
  checks.push(await checkClamavEicar());
  checks.push(await checkClamavSize(opts.clamavScanBytes ?? MAX_UPLOAD_BYTES));

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
