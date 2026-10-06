// =============================================================================
// Fehlerklassen des Storage-Pakets — bewusst ohne Imports, damit App-Code sie
// per `@taxtronik/storage/errors` zuordnen kann, ohne den S3-Client und die
// ENV-Validierung zu laden (zentrales Fehler-Mapping, Client-nahe Module).
// =============================================================================

export type StoredObjectErrorReason =
  | 'MISSING_BODY'
  | 'TOO_LARGE'
  | 'LENGTH_MISMATCH'
  | 'OVERFLOW'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH';

const INTEGRITY_REASONS: ReadonlySet<StoredObjectErrorReason> = new Set([
  'LENGTH_MISMATCH',
  'OVERFLOW',
  'SIZE_MISMATCH',
  'HASH_MISMATCH',
]);

/** Lesefehler mit Ursache; Meldungen beginnen mit dem Code (z. B. `TOO_LARGE: …`). */
export class StoredObjectError extends Error {
  constructor(
    readonly reason: StoredObjectErrorReason,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = 'StoredObjectError';
  }

  /** Inhalt weicht von der gebundenen Fassung ab — im Gegensatz zu Speicher-/Limitfehlern. */
  get integrityViolation(): boolean {
    return INTEGRITY_REASONS.has(this.reason);
  }
}

export type UploadRejectionReason =
  | 'TOO_LARGE'
  | 'INFECTED'
  | 'SCAN_ERROR'
  | 'INVALID_RETENTION_YEARS';

/**
 * Abgewiesener Schreibvorgang (Limit, Virenscan, unzulässige Frist). Die
 * Meldung behält das bisherige Format `CODE: …`; Aufrufer ordnen den Fehler
 * über die Klasse und `reason` ein statt über den Meldungstext.
 */
export class UploadRejectedError extends Error {
  constructor(
    readonly reason: UploadRejectionReason,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = 'UploadRejectedError';
  }
}
