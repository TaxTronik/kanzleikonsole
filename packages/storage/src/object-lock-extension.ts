// =============================================================================
// Object-Lock einer Objektversion verlängern (RT3D-K-01, kk-tcms-fix5).
//
// GwG-Belege liegen im GwG-Bucket unter einem GOVERNANCE-Lock von 5 Jahren und
// 1 Tag ab Upload (gwgRetentionUntil). Gilt ein Beleg als steuerliche Unterlage
// (Verweis des Tax-CMS, TCMS-NACHWEIS-001), steigt sein Aufbewahrungsende in
// der Datenbank auf die Steuerfrist bzw. das Ende der GwG-Frist. Der Worker-Job
// gwg-object-lock-extend zieht den Lock jeder Objektversion bis zu diesem Ende
// nach, damit nicht allein die Datenbank die Frist hält (zweite Linie).
//
// Regeln:
//   - nur die exakte Objektversion (VersionId), nie den Schlüssel allein;
//   - nur verlängern, nie verkürzen: Liegt das bestehende Ende schon auf oder
//     hinter dem Ziel, bleibt das Objekt unberührt. Die Anfrage trägt nie
//     BypassGovernanceRetention; S3 weist ein Verkürzen deshalb ohnehin ab
//     (GOVERNANCE ohne Bypass, COMPLIANCE immer);
//   - der Modus bleibt (GOVERNANCE bleibt GOVERNANCE, COMPLIANCE bleibt
//     COMPLIANCE); eine Version ohne Lock erhält GOVERNANCE wie beim Upload;
//   - danach wird nachgelesen: Ende mindestens das Ziel, Modus unverändert,
//     sonst Fehler (OBJECT_LOCK_EXTEND_UNVERIFIED).
// Idempotent: Ein zweiter Aufruf mit demselben Ziel ändert nichts.
// =============================================================================

import { GetObjectRetentionCommand, PutObjectRetentionCommand } from '@aws-sdk/client-s3';
import { s3 } from './client';

export type ObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

/** Exakte Objektversion im Object Store. */
export interface ObjectVersionRef {
  bucket: string;
  key: string;
  versionId: string;
}

export interface ObjectLockState {
  mode: ObjectLockMode;
  retainUntil: Date;
}

export interface ObjectLockExtension extends ObjectLockState {
  /** VERLAENGERT: neu gesetzt und nachgelesen; UNVERAENDERT: Ende lag schon auf oder hinter dem Ziel. */
  status: 'VERLAENGERT' | 'UNVERAENDERT';
}

/** Fehler mit festem Code (ohne Bucket, Schlüssel oder Antworttext des Speichers). */
export class ObjectLockExtensionError extends Error {
  constructor(
    readonly code:
      | 'STORAGE_VERSION_ID_MISSING'
      | 'OBJECT_LOCK_TARGET_INVALID'
      | 'OBJECT_LOCK_STATE_INVALID'
      | 'OBJECT_LOCK_EXTEND_UNVERIFIED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ObjectLockExtensionError';
  }
}

function versionInput(ref: ObjectVersionRef) {
  if (!ref.versionId.trim() || ref.versionId === 'null') {
    throw new ObjectLockExtensionError(
      'STORAGE_VERSION_ID_MISSING',
      'Ohne exakte Objektversion wird kein Object-Lock verlängert.',
    );
  }
  return { Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId };
}

function isNoLock(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'NoSuchObjectLockConfiguration';
}

/**
 * Bestehender Lock der Objektversion; `null`, wenn die Version keinen Lock
 * trägt (NoSuchObjectLockConfiguration). Jeder andere Fehler wird geworfen.
 */
export async function readObjectLock(ref: ObjectVersionRef): Promise<ObjectLockState | null> {
  const input = versionInput(ref);
  let retention;
  try {
    retention = (await s3.send(new GetObjectRetentionCommand(input))).Retention;
  } catch (error) {
    if (isNoLock(error)) return null;
    throw error;
  }
  if (!retention?.Mode && !retention?.RetainUntilDate) return null;
  const retainUntil = retention.RetainUntilDate ? new Date(retention.RetainUntilDate) : null;
  if (
    (retention.Mode !== 'GOVERNANCE' && retention.Mode !== 'COMPLIANCE') ||
    !retainUntil ||
    !Number.isFinite(retainUntil.getTime())
  ) {
    throw new ObjectLockExtensionError(
      'OBJECT_LOCK_STATE_INVALID',
      'Der Object Store meldet einen unvollständigen Lock.',
    );
  }
  return { mode: retention.Mode, retainUntil };
}

/**
 * Verlängert den Object-Lock der exakten Objektversion bis mindestens
 * `retainUntil`; verkürzt nie (siehe Kopf). Liefert den nachgelesenen Stand.
 */
export async function extendObjectLockRetention(
  ref: ObjectVersionRef,
  retainUntil: Date,
): Promise<ObjectLockExtension> {
  if (!Number.isFinite(retainUntil.getTime())) {
    throw new ObjectLockExtensionError('OBJECT_LOCK_TARGET_INVALID', 'Ungültiges Lock-Ende.');
  }
  const input = versionInput(ref);
  const before = await readObjectLock(ref);
  if (before && before.retainUntil.getTime() >= retainUntil.getTime()) {
    return { status: 'UNVERAENDERT', ...before };
  }
  const mode: ObjectLockMode = before?.mode ?? 'GOVERNANCE';
  // Ohne BypassGovernanceRetention: Der Speicher lässt damit nur Verlängern zu.
  await s3.send(
    new PutObjectRetentionCommand({
      ...input,
      Retention: { Mode: mode, RetainUntilDate: retainUntil },
    }),
  );
  const after = await readObjectLock(ref);
  if (!after || after.mode !== mode || after.retainUntil.getTime() < retainUntil.getTime()) {
    throw new ObjectLockExtensionError(
      'OBJECT_LOCK_EXTEND_UNVERIFIED',
      'Der verlängerte Lock ist nach dem Setzen nicht nachweisbar.',
    );
  }
  return { status: 'VERLAENGERT', ...after };
}
