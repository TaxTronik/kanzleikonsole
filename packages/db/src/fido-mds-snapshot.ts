// =============================================================================
// FIDO-MDS-Snapshot (P-23): Ablage durch den Worker, Lesezugriff der App
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Der Worker-Job `fido-mds-refresh` lädt den signierten FIDO-MDS-BLOB, prüft
// Signer-Identität, JWT-Signatur, Zertifikatskette, CRLs, Serie und nextUpdate
// und legt das Ergebnis mit storeFidoMdsSnapshot() im owner-only Anker
// `fido_mds_trust_state` ab (Spalten snapshot_*). Hardware-Anmeldung,
// -Registrierung und Modus-Assertions der Web-App lesen über
// readFidoMdsTrustState()/readFidoMdsSnapshotEntries() ausschließlich diesen
// Stand; kein Request kontaktiert den Metadata Service.
//
// Der Anker enthält keine Mandanten- oder Personendaten; die App-Rolle hat
// keinerlei Tabellenrechte. Die Policy-Spalten gehören der App
// (Allowlist-Revision und -Hash); der Worker schreibt nur Serie, nextUpdate,
// Prüfzeitpunkt und Snapshot. Ein Snapshot gilt nur, solange snapshot_serial
// der verankerten blob_serial entspricht – rückt eine ältere App-Replica
// (vor P-23) die Serie selbst vor, sperren Hardware-Vorgänge bis zum nächsten
// Worker-Lauf fail-closed.
// =============================================================================

import type { PrismaClientInstance } from './prisma-client';

/** Policy eines vom Worker neu angelegten Ankers: Revision 0 = noch von keiner App beansprucht. */
export const FIDO_MDS_UNCLAIMED_POLICY_HASH = '0'.repeat(64);
/** Großzügig für einen mehrere MB großen JSONB-Wert; nur der Worker schreibt. */
const STORE_TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type FidoMdsQueryClient = Pick<PrismaClientInstance, '$queryRaw'>;
export type FidoMdsTransactionClient = Pick<PrismaClientInstance, '$queryRaw' | '$transaction'>;

/** Persistenter Vertrauensanker samt Prüfsumme des zur Serie passenden Snapshots. */
export type FidoMdsTrustState = {
  blobSerial: bigint;
  /** MDS-Kalenderdatum `YYYY-MM-DD`. */
  nextUpdate: string;
  /** Letzte erfolgreiche Prüfung des BLOBs dieser Serie (DB-Zeit). */
  verifiedAt: Date;
  policyRevision: bigint;
  policyHash: string;
  /** null = für die verankerte Serie liegt (noch) kein Snapshot vor. */
  snapshotSha256: string | null;
};

export async function readFidoMdsTrustState(
  client: FidoMdsQueryClient,
): Promise<FidoMdsTrustState | null> {
  const rows = await client.$queryRaw<
    Array<{
      blob_serial: bigint;
      next_update: string;
      verified_at: Date;
      policy_revision: bigint;
      policy_hash: string;
      snapshot_sha256: string | null;
    }>
  >`
    SELECT trust_state."blob_serial",
           to_char(trust_state."next_update", 'YYYY-MM-DD') AS "next_update",
           trust_state."verified_at",
           trust_state."policy_revision",
           trust_state."policy_hash",
           CASE
             WHEN trust_state."snapshot_serial" = trust_state."blob_serial"
               THEN trust_state."snapshot_sha256"
           END AS "snapshot_sha256"
      FROM public."fido_mds_trust_state" AS trust_state
     WHERE trust_state."singleton" = TRUE
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    blobSerial: row.blob_serial,
    nextUpdate: row.next_update,
    verifiedAt: row.verified_at,
    policyRevision: row.policy_revision,
    policyHash: row.policy_hash,
    snapshotSha256: row.snapshot_sha256,
  };
}

/**
 * Liest aus dem Snapshot einer Serie nur die Einträge der angefragten AAGUIDs
 * (unabhängig von Groß-/Kleinschreibung, in BLOB-Reihenfolge). Der Login lädt
 * damit wenige KB statt des vollständigen, mehrere MB großen MDS-Stands.
 * null = für diese Serie liegt kein Snapshot (mehr) vor.
 */
export async function readFidoMdsSnapshotEntries(
  client: FidoMdsQueryClient,
  input: { blobSerial: bigint; aaguids: readonly string[] },
): Promise<{ blobSha256: string; entries: unknown[] } | null> {
  const aaguids = input.aaguids.map((aaguid) => aaguid.toLowerCase());
  const rows = await client.$queryRaw<Array<{ blob_sha256: string; entry: unknown }>>`
    SELECT trust_state."snapshot_sha256" AS "blob_sha256", entry.value AS "entry"
      FROM public."fido_mds_trust_state" AS trust_state
      LEFT JOIN LATERAL jsonb_array_elements(trust_state."snapshot_entries")
             WITH ORDINALITY AS entry(value, position)
        ON lower(entry.value ->> 'aaguid') = ANY(${aaguids}::text[])
     WHERE trust_state."singleton" = TRUE
       AND trust_state."snapshot_serial" = ${input.blobSerial}
     ORDER BY entry.position
  `;
  const first = rows[0];
  if (!first) return null;
  return {
    blobSha256: first.blob_sha256,
    entries: rows.flatMap((row) => (row.entry == null ? [] : [row.entry])),
  };
}

export class FidoMdsSnapshotOutdatedError extends Error {
  constructor() {
    super('Der signierte FIDO-MDS-BLOB ist älter als der persistente Vertrauensstand');
    this.name = 'FidoMdsSnapshotOutdatedError';
  }
}

export type FidoMdsSnapshotInput = {
  /** Fortlaufende BLOB-Nummer (`no`) des geprüften BLOBs. */
  serial: number;
  /** Geprüftes nextUpdate (UTC-Mitternacht des MDS-Kalenderdatums). */
  nextUpdate: Date;
  /** SHA-256 (hex) des unveränderten JWT-BLOBs. */
  blobSha256: string;
  /** Geprüfte Payload-Einträge; die App filtert erst beim Lesen nach ihrer Allowlist. */
  entries: readonly unknown[];
};

/**
 * Legt einen vollständig geprüften MDS-Stand ab und verankert seine Serie.
 *
 * - Ein älterer BLOB als der Anker wird abgewiesen (kein Rückfall auf einen
 *   veralteten oder zurückgespielten Stand); nichts wird geändert.
 * - Ein unveränderter BLOB (gleiche Serie und Prüfsumme) wird nicht erneut
 *   geschrieben; nur der Prüfzeitpunkt `verified_at` rückt vor.
 * - Die Policy-Spalten bleiben unberührt; ein neu angelegter Anker trägt die
 *   unbeanspruchte Policy (Revision 0), bis die App ihre Policy bindet.
 */
export async function storeFidoMdsSnapshot(
  client: FidoMdsTransactionClient,
  input: FidoMdsSnapshotInput,
): Promise<'stored' | 'unchanged'> {
  if (!Number.isSafeInteger(input.serial) || input.serial <= 0) {
    throw new Error('Der FIDO-MDS-Snapshot besitzt keine gültige fortlaufende Version');
  }
  if (!(input.nextUpdate instanceof Date) || !Number.isFinite(input.nextUpdate.getTime())) {
    throw new Error('Der FIDO-MDS-Snapshot besitzt kein gültiges nextUpdate');
  }
  if (!SHA256_HEX_PATTERN.test(input.blobSha256)) {
    throw new Error('Der FIDO-MDS-Snapshot besitzt keine gültige Prüfsumme');
  }
  if (!Array.isArray(input.entries)) {
    throw new Error('Der FIDO-MDS-Snapshot besitzt keine Eintragsliste');
  }
  const serial = BigInt(input.serial);
  const nextUpdate = input.nextUpdate.toISOString().slice(0, 10);

  // Vorabprüfung ohne Sperre: einen veralteten BLOB gar nicht erst übertragen.
  const [current] = await client.$queryRaw<Array<{ blob_serial: bigint }>>`
    SELECT "blob_serial" FROM public."fido_mds_trust_state" WHERE "singleton" = TRUE
  `;
  if (current && current.blob_serial > serial) throw new FidoMdsSnapshotOutdatedError();

  return client.$transaction(async (tx) => {
    // Fehlt der Anker noch (App nie gestartet), entsteht er im fail-closed
    // Initialzustand; die App beansprucht ihre Policy später selbst.
    await tx.$executeRaw`
      INSERT INTO public."fido_mds_trust_state" (
        "singleton", "blob_serial", "next_update", "verified_at",
        "policy_revision", "policy_hash"
      ) VALUES (
        TRUE, 0, DATE '1970-01-01', TIMESTAMPTZ '1970-01-01 00:00:00+00',
        0, ${FIDO_MDS_UNCLAIMED_POLICY_HASH}
      )
      ON CONFLICT ("singleton") DO NOTHING
    `;
    // Ab hier hält der Worker den Anker exklusiv; laufende WebAuthn-Commits
    // (SHARE-Lock über app.lock_matching_fido_mds_state) werden abgewartet.
    const [anchor] = await tx.$queryRaw<
      Array<{ blob_serial: bigint; snapshot_serial: bigint | null; snapshot_sha256: string | null }>
    >`
      SELECT "blob_serial", "snapshot_serial", "snapshot_sha256"
        FROM public."fido_mds_trust_state"
       WHERE "singleton" = TRUE
         FOR UPDATE
    `;
    if (!anchor) throw new Error('Der persistente FIDO-MDS-Vertrauensanker fehlt');
    if (anchor.blob_serial > serial) throw new FidoMdsSnapshotOutdatedError();
    if (anchor.snapshot_serial === serial && anchor.snapshot_sha256 === input.blobSha256) {
      await tx.$executeRaw`
        UPDATE public."fido_mds_trust_state"
           SET "blob_serial" = ${serial},
               "next_update" = ${nextUpdate}::date,
               "verified_at" = CURRENT_TIMESTAMP
         WHERE "singleton" = TRUE
      `;
      return 'unchanged';
    }
    await tx.$executeRaw`
      UPDATE public."fido_mds_trust_state"
         SET "blob_serial" = ${serial},
             "next_update" = ${nextUpdate}::date,
             "verified_at" = CURRENT_TIMESTAMP,
             "snapshot_serial" = ${serial},
             "snapshot_sha256" = ${input.blobSha256},
             "snapshot_entries" = ${JSON.stringify(input.entries)}::jsonb
       WHERE "singleton" = TRUE
    `;
    return 'stored';
  }, STORE_TRANSACTION_OPTIONS);
}
