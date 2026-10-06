// =============================================================================
// FIDO-Metadaten der Hardware-Anmeldung (P-23)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Den signierten FIDO-MDS-BLOB lädt und prüft ausschließlich der Worker-Job
// `fido-mds-refresh` (Signer-Identität, JWT-Signatur, Zertifikatskette, CRL,
// fortlaufende Serie, nextUpdate). Er verankert die Serie monoton im
// owner-only Anker `fido_mds_trust_state` und legt die geprüften Einträge im
// selben Datensatz ab (snapshot_*). Anmeldung, Registrierung und
// Modus-Assertions lesen nur diesen gespeicherten Stand; kein Request
// kontaktiert mds.fidoalliance.org.
//
// Fail-closed: Fehlt ein Snapshot, ist er älter als eine Stunde (letzte
// erfolgreiche Prüfung) oder hat sein BLOB das nextUpdate erreicht, ist der
// Hardware-Zugang nicht verfügbar. Die Allowlist wird erst danach je Prozess
// gegen den Snapshot ausgewertet; ein neuer Stand ohne nutzbares Modell
// verdrängt damit ebenfalls den Prozess-Cache.
// =============================================================================

import { createHash } from 'node:crypto';
import {
  MetadataService,
  type AuthenticatorStatus,
  type MetadataBLOBPayloadEntry,
  type MetadataStatement,
} from '@simplewebauthn/server';
import { env } from '@taxtronik/config';
import type { TxClient } from '@taxtronik/db';
import { readFidoMdsSnapshotEntries, readFidoMdsTrustState } from '@taxtronik/db/fido-mds-snapshot';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { libraryAttestationStatement } from './webauthn-attestation';
import { HardwareAccessUnavailableError, HardwareAccessVerificationError } from './webauthn-shared';

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';
/** Höchstalter der letzten erfolgreichen MDS-Prüfung, bevor Hardware-Vorgänge sperren. */
const FIDO_MDS_MAX_SNAPSHOT_AGE_MS = 60 * 60 * 1000;
const MDS_CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MAX_AUTHENTICATOR_VERSION = 0xffff_ffff;
const HARDWARE_POLICY_SCHEMA_VERSION = 1;
const TRUSTED_CERTIFICATION_STATUSES = new Set<AuthenticatorStatus>([
  'FIDO_CERTIFIED',
  'FIDO_CERTIFIED_L1',
  'FIDO_CERTIFIED_L1plus',
  'FIDO_CERTIFIED_L2',
  'FIDO_CERTIFIED_L2plus',
  'FIDO_CERTIFIED_L3',
  'FIDO_CERTIFIED_L3plus',
]);
const ACCEPTED_AUTHENTICATOR_STATUSES = new Set<AuthenticatorStatus>([
  ...TRUSTED_CERTIFICATION_STATUSES,
  'UPDATE_AVAILABLE',
]);

export type HardwareMetadataSnapshot = {
  entries: Map<string, MetadataBLOBPayloadEntry>;
  nextUpdate: Date;
  serial: number;
  verifiedAt: Date;
};

/** Persistenter Vertrauensstand samt Prüfsumme des zugehörigen Snapshots. */
type StoredTrustState = {
  blobSerial: bigint;
  nextUpdate: Date;
  verifiedAt: Date;
  policyRevision: bigint;
  policyHash: string;
  snapshotSha256: string | null;
};

/** Ein Ladevorgang je gespeichertem Stand (Serie, BLOB-Prüfsumme, Policy). */
let hardwareMetadataReadiness: { key: string; snapshot: Promise<HardwareMetadataSnapshot> } | null =
  null;

export function resetHardwareMetadataCacheForTests(): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error('Der FIDO-MDS-Test-Reset ist ausschließlich in Tests zulässig.');
  }
  hardwareMetadataReadiness = null;
}

function configuredHardwareAaguids(): string[] {
  const configured = env.WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST;
  if (configured.length === 0 || configured.includes(ZERO_AAGUID)) {
    throw new HardwareAccessUnavailableError(
      'Die Hardware-Vertrauensliste ist nicht konfiguriert.',
    );
  }
  return configured;
}

export type HardwarePolicyBinding = {
  aaguids: string[];
  enabled: boolean;
  revision: bigint;
  hash: string;
};

export function configuredHardwarePolicy(): HardwarePolicyBinding {
  const configured = env.WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST;
  const enabled = configured.length > 0 && !configured.includes(ZERO_AAGUID);
  const aaguids = enabled ? configured : [];
  const canonical = JSON.stringify({
    version: HARDWARE_POLICY_SCHEMA_VERSION,
    enabled,
    aaguids: [...aaguids].sort(),
  });
  return {
    aaguids,
    enabled,
    revision: BigInt(env.WEBAUTHN_HARDWARE_POLICY_REVISION),
    hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}

async function claimHardwarePolicyBinding(policy: HardwarePolicyBinding): Promise<void> {
  const rows = await prismaOwner.$queryRaw<Array<{ policy_revision: bigint; policy_hash: string }>>`
    INSERT INTO public."fido_mds_trust_state" (
      "singleton", "blob_serial", "next_update", "verified_at",
      "policy_revision", "policy_hash"
    ) VALUES (
      TRUE, 0, DATE '1970-01-01', TIMESTAMPTZ '1970-01-01 00:00:00+00',
      ${policy.revision}, ${policy.hash}
    )
    ON CONFLICT ("singleton") DO UPDATE
      SET "policy_revision" = EXCLUDED."policy_revision",
          "policy_hash" = EXCLUDED."policy_hash"
      WHERE public."fido_mds_trust_state"."policy_revision" < EXCLUDED."policy_revision"
         OR (
           public."fido_mds_trust_state"."policy_revision" = EXCLUDED."policy_revision"
           AND public."fido_mds_trust_state"."policy_hash" = EXCLUDED."policy_hash"
         )
    RETURNING "policy_revision", "policy_hash"
  `;
  if (rows[0]?.policy_revision !== policy.revision || rows[0]?.policy_hash !== policy.hash) {
    throw new Error('Die Hardware-Policy ist nicht neuer als der persistente Vertrauensstand');
  }
}

export async function initializeHardwareAccessPolicy(): Promise<void> {
  const policy = configuredHardwarePolicy();
  await claimHardwarePolicyBinding(policy);
  if (!policy.enabled) hardwareMetadataReadiness = null;
}

export function parseAuthenticatorVersion(value: unknown, source: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_AUTHENTICATOR_VERSION
  ) {
    throw new HardwareAccessVerificationError(
      `Die Hardware-Attestation enthält keine gültige ${source}.`,
    );
  }
  return value;
}

function assertTrustedHardwareStatement(aaguid: string, statement: MetadataStatement): number {
  const keyProtection = new Set(statement.keyProtection);
  const attachmentHints = new Set(statement.attachmentHint ?? []);
  if (
    (statement.aaguid && statement.aaguid.toLowerCase() !== aaguid) ||
    statement.attestationRootCertificates.length === 0 ||
    !statement.attestationTypes.includes('basic_full') ||
    (!keyProtection.has('hardware') && !keyProtection.has('secure_element')) ||
    keyProtection.has('software') ||
    keyProtection.has('remote_handle') ||
    !attachmentHints.has('external') ||
    attachmentHints.has('internal') ||
    statement.authenticatorGetInfo?.options?.plat === true
  ) {
    throw new Error(`AAGUID ${aaguid} erfüllt die Hardware-Richtlinie nicht`);
  }
  return parseAuthenticatorVersion(
    statement.authenticatorVersion,
    'Firmware-Mindestversion im Metadata Statement',
  );
}

/**
 * Die Statement-Kopie im MetadataService von SimpleWebAuthn muss bis auf die
 * Wurzeln der vertrauenswürdigen entsprechen. Trüge sie Wurzeln, prüfte die
 * Bibliothek die Kette selbst und lüde Sperrlisten ungehärtet vor dem
 * Kettenaufbau (T-02); die Kette prüft webauthn-attestation.ts.
 */
function assertLibraryAttestationStatement(
  aaguid: string,
  statement: MetadataStatement,
  trusted: MetadataStatement,
): void {
  if (statement.attestationRootCertificates.length !== 0) {
    throw new Error(`AAGUID ${aaguid}: SimpleWebAuthn darf keine Attestationswurzeln erhalten`);
  }
  assertTrustedHardwareStatement(aaguid, {
    ...statement,
    attestationRootCertificates: trusted.attestationRootCertificates,
  });
}

function parseMdsCalendarDate(value: unknown, field: 'effectiveDate' | 'sunsetDate'): number {
  const match = typeof value === 'string' ? MDS_CALENDAR_DATE_PATTERN.exec(value) : null;
  if (!match) {
    throw new HardwareAccessVerificationError(
      `Die Hardware-Attestation enthält kein gültiges MDS-${field}.`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new HardwareAccessVerificationError(
      `Die Hardware-Attestation enthält kein gültiges MDS-${field}.`,
    );
  }
  return timestamp;
}

function assertTrustedMetadataEntry(
  aaguid: string,
  entry: MetadataBLOBPayloadEntry,
  deviceAuthenticatorVersion?: number | null,
): void {
  if (
    entry.aaguid?.toLowerCase() !== aaguid ||
    !entry.metadataStatement ||
    !Array.isArray(entry.statusReports)
  ) {
    throw new HardwareAccessVerificationError(
      'Die Hardware-Attestation enthält keinen belastbaren MDS-Status.',
    );
  }

  const statementMinimumVersion = assertTrustedHardwareStatement(aaguid, entry.metadataStatement);
  const deviceVersion =
    deviceAuthenticatorVersion === undefined
      ? undefined
      : parseAuthenticatorVersion(
          deviceAuthenticatorVersion,
          'attestierte Firmware-Version des Sicherheitsschlüssels',
        );
  let currentlyCertified = false;
  const now = Date.now();
  for (const report of entry.statusReports) {
    if (!ACCEPTED_AUTHENTICATOR_STATUSES.has(report.status)) {
      throw new HardwareAccessVerificationError(
        'Die Hardware-Attestation des Sicherheitsschlüssels ist nicht vertrauenswürdig.',
      );
    }
    let effective = true;
    if (report.effectiveDate !== undefined) {
      effective = parseMdsCalendarDate(report.effectiveDate, 'effectiveDate') <= now;
    }
    const sunsetDate = (report as typeof report & { sunsetDate?: unknown }).sunsetDate;
    const notExpired =
      sunsetDate === undefined || parseMdsCalendarDate(sunsetDate, 'sunsetDate') > now;
    const reportMinimumVersion =
      report.authenticatorVersion === undefined
        ? 0
        : parseAuthenticatorVersion(
            report.authenticatorVersion,
            'Firmware-Mindestversion im MDS-Statusbericht',
          );
    const firmwareMeetsMinimum =
      deviceVersion === undefined ||
      (deviceVersion >= statementMinimumVersion && deviceVersion >= reportMinimumVersion);
    if (
      effective &&
      notExpired &&
      firmwareMeetsMinimum &&
      TRUSTED_CERTIFICATION_STATUSES.has(report.status)
    ) {
      currentlyCertified = true;
    }
  }
  if (!currentlyCertified) {
    throw new HardwareAccessVerificationError(
      'Die Hardware-Attestation besitzt keinen aktuellen FIDO-Zertifizierungsstatus.',
    );
  }
}

/** `YYYY-MM-DD` des gespeicherten nextUpdate als UTC-Mitternacht (wie parsedNextUpdate). */
function parseStoredNextUpdate(value: string): Date {
  const match = MDS_CALENDAR_DATE_PATTERN.exec(value);
  if (!match) throw new Error('Der persistente FIDO-MDS-Vertrauensanker ist ungültig');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

async function currentHardwareMetadataState(): Promise<StoredTrustState> {
  const state = await readFidoMdsTrustState(prismaOwner);
  if (!state) throw new Error('Der persistente FIDO-MDS-Vertrauensanker fehlt');
  return { ...state, nextUpdate: parseStoredNextUpdate(state.nextUpdate) };
}

export async function lockMatchingHardwareMetadataSerial(
  tx: TxClient,
  expectedSerial: bigint,
): Promise<void> {
  const policy = configuredHardwarePolicy();
  if (!policy.enabled) {
    throw new HardwareAccessUnavailableError('Der Hardware-Zugang ist zentral deaktiviert.');
  }
  const rows = await tx.$queryRaw<Array<{ matches: boolean | null }>>`
    SELECT app.lock_matching_fido_mds_state(
      ${expectedSerial},
      ${policy.revision},
      ${policy.hash}
    ) AS "matches"
  `;
  if (rows[0]?.matches !== true) {
    throw new HardwareAccessVerificationError(
      'Der FIDO-Vertrauensstand wurde zwischenzeitlich aktualisiert. Bitte wiederholen Sie den Vorgang.',
    );
  }
}

/**
 * Wertet den vom Worker signaturgeprüft gespeicherten Snapshot gegen die
 * lokale Allowlist aus. SimpleWebAuthn erhält ausschließlich die positiv
 * geprüften Statements, weil dessen getStatement() nur das Statement, nicht
 * aber den übergeordneten Zertifizierungs-/Sperrstatus liefert, und zwar ohne
 * attestationRootCertificates: Die Attestationskette prüft
 * webauthn-attestation.ts gegen die Wurzeln des gespeicherten Statements.
 */
async function loadStoredHardwareMetadataSnapshot(
  state: StoredTrustState,
  policy: HardwarePolicyBinding,
): Promise<HardwareMetadataSnapshot> {
  // Nur die Einträge der freigegebenen Modelle, nicht der vollständige Stand.
  const stored = await readFidoMdsSnapshotEntries(prismaOwner, {
    blobSerial: state.blobSerial,
    aaguids: policy.aaguids,
  });
  if (!stored || stored.blobSha256 !== state.snapshotSha256) {
    throw new Error('Der gespeicherte FIDO-MDS-Snapshot fehlt oder wurde zwischenzeitlich ersetzt');
  }
  const byAaguid = new Map(
    (stored.entries as MetadataBLOBPayloadEntry[])
      .filter(
        (entry): entry is MetadataBLOBPayloadEntry & { aaguid: string } =>
          typeof entry?.aaguid === 'string',
      )
      .map((entry) => [entry.aaguid.toLowerCase(), entry]),
  );
  const entries = new Map<string, MetadataBLOBPayloadEntry>();
  const statements: MetadataStatement[] = [];
  for (const aaguid of policy.aaguids) {
    try {
      const entry = byAaguid.get(aaguid);
      if (!entry) throw new Error(`Keine FIDO-Metadaten für AAGUID ${aaguid}`);
      assertTrustedMetadataEntry(aaguid, entry);
      entries.set(aaguid, entry);
      statements.push(entry.metadataStatement!);
    } catch (error) {
      log.warn(
        { component: 'staff-webauthn', aaguid, err: (error as Error).message },
        'FIDO-Schlüsselmodell aus aktuellem Vertrauenssnapshot ausgeschlossen',
      );
    }
  }
  if (entries.size === 0) {
    throw new HardwareAccessUnavailableError(
      'Keines der freigegebenen Sicherheitsschlüssel-Modelle besitzt aktuell einen belastbaren FIDO-Nachweis.',
    );
  }

  await MetadataService.initialize({
    mdsServers: [],
    statements: statements.map(libraryAttestationStatement),
    verificationMode: 'strict',
  });
  for (const aaguid of entries.keys()) {
    try {
      const statement = await MetadataService.getStatement(aaguid);
      if (!statement) throw new Error(`Keine prüfbare FIDO-Attestation für AAGUID ${aaguid}`);
      assertLibraryAttestationStatement(aaguid, statement, entries.get(aaguid)!.metadataStatement!);
    } catch (error) {
      entries.delete(aaguid);
      log.warn(
        { component: 'staff-webauthn', aaguid, err: (error as Error).message },
        'FIDO-Schlüsselmodell konnte nicht in den Attestationsspeicher übernommen werden',
      );
    }
  }
  if (entries.size === 0) {
    throw new HardwareAccessUnavailableError(
      'Keines der freigegebenen Sicherheitsschlüssel-Modelle kann aktuell verifiziert werden.',
    );
  }
  return {
    entries,
    nextUpdate: state.nextUpdate,
    serial: Number(state.blobSerial),
    verifiedAt: state.verifiedAt,
  };
}

/** Prüft den gespeicherten Stand; wirft fail-closed, wenn er fehlt oder veraltet ist. */
function assertUsableTrustState(state: StoredTrustState, policy: HardwarePolicyBinding): void {
  if (state.blobSerial <= 0n || !state.snapshotSha256) {
    // Explizit: Vor der ersten erfolgreichen Prüfung durch den Worker-Job
    // fido-mds-refresh gibt es keinen Hardware-Vorgang (auch keinen Login).
    log.warn(
      { component: 'staff-webauthn' },
      'FIDO-Metadaten liegen noch nicht vor (Worker-Job fido-mds-refresh)',
    );
    throw new HardwareAccessUnavailableError(
      'Die Hardware-Attestation kann derzeit nicht geprüft werden.',
    );
  }
  const now = Date.now();
  if (
    state.nextUpdate.getTime() <= now ||
    now - state.verifiedAt.getTime() > FIDO_MDS_MAX_SNAPSHOT_AGE_MS
  ) {
    log.warn(
      {
        component: 'staff-webauthn',
        serial: state.blobSerial.toString(),
        verifiedAt: state.verifiedAt.toISOString(),
      },
      'FIDO-Metadaten sind veraltet (Worker-Job fido-mds-refresh prüfen)',
    );
    throw new HardwareAccessUnavailableError(
      'Die Hardware-Attestation kann derzeit nicht geprüft werden.',
    );
  }
  if (state.policyRevision !== policy.revision || state.policyHash !== policy.hash) {
    throw new HardwareAccessUnavailableError(
      'Die Hardware-Attestation kann derzeit nicht geprüft werden.',
    );
  }
}

export async function ensureHardwareMetadataReady(): Promise<HardwareMetadataSnapshot> {
  const policy = configuredHardwarePolicy();
  await claimHardwarePolicyBinding(policy);
  if (!policy.enabled) {
    throw new HardwareAccessUnavailableError('Der Hardware-Zugang ist zentral deaktiviert.');
  }
  let state: StoredTrustState;
  try {
    state = await currentHardwareMetadataState();
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'FIDO-Metadaten-Richtlinie ist nicht bereit',
    );
    throw new HardwareAccessUnavailableError(
      'Die Hardware-Attestation kann derzeit nicht geprüft werden.',
      { cause: error },
    );
  }
  assertUsableTrustState(state, policy);
  const key = `${state.blobSerial}:${state.snapshotSha256}:${policy.hash}`;
  let pending = hardwareMetadataReadiness;
  if (pending?.key !== key) {
    pending = { key, snapshot: loadStoredHardwareMetadataSnapshot(state, policy) };
    hardwareMetadataReadiness = pending;
  }
  try {
    const snapshot = await pending.snapshot;
    // Die Freshness folgt dem persistenten Prüfzeitpunkt, nicht dem Ladezeitpunkt.
    return { ...snapshot, nextUpdate: state.nextUpdate, verifiedAt: state.verifiedAt };
  } catch (error) {
    if (hardwareMetadataReadiness === pending) hardwareMetadataReadiness = null;
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'FIDO-Metadaten-Richtlinie ist nicht bereit',
    );
    if (
      error instanceof HardwareAccessUnavailableError ||
      error instanceof HardwareAccessVerificationError
    ) {
      throw error;
    }
    throw new HardwareAccessUnavailableError(
      'Die Hardware-Attestation kann derzeit nicht geprüft werden.',
      { cause: error },
    );
  }
}

export async function currentTrustedHardwareStatement(
  aaguid: string,
  authenticatorVersion: number,
): Promise<{ statement: MetadataStatement; metadataSerial: bigint }> {
  const normalized = aaguid.toLowerCase();
  if (!configuredHardwareAaguids().includes(normalized)) {
    throw new HardwareAccessVerificationError(
      'Dieses Sicherheitsschlüssel-Modell ist nicht freigegeben.',
    );
  }
  const snapshot = await ensureHardwareMetadataReady();
  try {
    const entry = snapshot.entries.get(normalized);
    if (!entry) throw new Error(`Keine FIDO-Metadaten für AAGUID ${normalized}`);
    assertTrustedMetadataEntry(normalized, entry, authenticatorVersion);
    const trusted = entry.metadataStatement!;
    const statement = await MetadataService.getStatement(normalized);
    if (!statement) throw new Error(`Keine FIDO-Metadaten für AAGUID ${normalized}`);
    assertLibraryAttestationStatement(normalized, statement, trusted);
    // Das gespeicherte Statement samt Wurzeln: Grundlage der eigenen Kettenprüfung.
    return { statement: trusted, metadataSerial: BigInt(snapshot.serial) };
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', aaguid: normalized, err: (error as Error).message },
      'FIDO-Hardware-Attestation wurde abgewiesen',
    );
    throw new HardwareAccessVerificationError(
      'Die Hardware-Attestation des Sicherheitsschlüssels ist nicht vertrauenswürdig.',
    );
  }
}
