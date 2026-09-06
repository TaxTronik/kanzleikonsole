import { createHash, randomBytes } from 'node:crypto';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from '@peculiar/x509';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  MetadataService,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorStatus,
  type AuthenticatorTransportFuture,
  type MetadataBLOBPayloadEntry,
  type MetadataStatement,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeAttestationObject, verifyMDSBlob } from '@simplewebauthn/server/helpers';
import { env } from '@taxtronik/config';
import type { TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { auditIp } from './login-audit';
import { getRedis } from '@/server/redis';

export const HARDWARE_ONLY_MIN_KEYS = 2;
export const HARDWARE_KEY_LIMIT = 10;
const CEREMONY_TTL_SECONDS = 5 * 60;
const RESPONSE_JSON_MAX_CHARS = 128 * 1024;
const REGISTRATION_RESPONSE_JSON_MAX_CHARS = 768 * 1024;
const ATTESTATION_OBJECT_MAX_CHARS = 512 * 1024;
const ATTESTATION_CERTIFICATE_MAX_BYTES = 64 * 1024;
const ATTESTATION_CERTIFICATE_CHAIN_MAX = 5;
const CEREMONY_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';
const FIDO_MDS_URL = 'https://mds.fidoalliance.org/';
const FIDO_MDS_SIGNER_HOSTNAME = 'mds.fidoalliance.org';
const FIDO_MDS_SIGNER_ORGANIZATION = 'Fido Alliance, Inc.';
const FIDO_MDS_SIGNER_INTERMEDIATE_CN = 'GlobalSign GCC R46 EV TLS CA 2025';
const FIDO_MDS_SIGNER_INTERMEDIATE_ORGANIZATION = 'GlobalSign nv-sa';
const FIDO_MDS_MAX_BLOB_BYTES = 20 * 1024 * 1024;
const FIDO_MDS_MAX_HEADER_CHARS = 512 * 1024;
const FIDO_MDS_MAX_CERTIFICATE_CHARS = 64 * 1024;
const FIDO_MDS_TIMEOUT_MS = 30_000;
const FIDO_ATTESTATION_TIMEOUT_MS = 30_000;
const FIDO_MDS_MAX_SNAPSHOT_AGE_MS = 60 * 60 * 1000;
const MDS_CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIDO_AAGUID_OID = '1.3.6.1.4.1.45724.1.1.4';
const FIDO_FIRMWARE_VERSION_OID = '1.3.6.1.4.1.45724.1.1.5';
const MAX_AUTHENTICATOR_VERSION = 0xffff_ffff;
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

export type HardwareCeremonyPurpose =
  | 'login'
  | 'register'
  | 'mode-enable'
  | 'mode-disable'
  | 'admin-recovery';

export type HardwareCeremony = {
  version: 1;
  purpose: HardwareCeremonyPurpose;
  challenge: string;
  origin: string;
  rpID: string;
  staffId?: string;
  tenantId?: string;
  targetStaffId?: string;
  authRevision?: number;
};

export type StoredHardwareCredential = {
  id: string;
  aaguid: string;
  publicKey: Uint8Array;
  signCount: bigint;
  webauthnUserId: string;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  attestationFormat: string;
  attestationVerifiedAt: Date;
  authenticatorVersion: bigint | null;
};

export type HardwareCredentialTrustInput = Pick<
  StoredHardwareCredential,
  'transports' | 'deviceType' | 'backedUp' | 'attestationFormat' | 'attestationVerifiedAt'
> & { aaguid: string | null; authenticatorVersion: bigint | null };

export type VerifiedHardwareRegistration = {
  credentialId: string;
  publicKey: Uint8Array;
  signCount: bigint;
  transports: AuthenticatorTransportFuture[];
  deviceType: 'singleDevice';
  backedUp: false;
  attestationFormat: 'packed';
  attestationVerifiedAt: Date;
  aaguid: string;
  authenticatorVersion: bigint;
  metadataSerial: bigint;
};

export type VerifiedHardwareAssertion = {
  newSignCount: bigint;
  metadataSerial: bigint;
};

export type HardwareLoginUser = {
  id: string;
  email: string;
  name: string;
  staffId: string;
  tenantId: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  authMethod: 'security_key';
  authRevision: number;
};

export class HardwareAccessUnavailableError extends Error {
  constructor(
    message = 'Sicherheitsschlüssel sind derzeit nicht verfügbar.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HardwareAccessUnavailableError';
  }
}

export class HardwareAccessVerificationError extends Error {
  constructor(
    message = 'Der Sicherheitsschlüssel konnte nicht verifiziert werden.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HardwareAccessVerificationError';
  }
}

type HardwareMetadataSnapshot = {
  entries: Map<string, MetadataBLOBPayloadEntry>;
  nextUpdate: Date;
  serial: number;
  verifiedAt: Date;
};

let hardwareMetadataReadiness: Promise<HardwareMetadataSnapshot> | null = null;

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

type HardwarePolicyBinding = {
  aaguids: string[];
  enabled: boolean;
  revision: bigint;
  hash: string;
};

function configuredHardwarePolicy(): HardwarePolicyBinding {
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

export function isHardwareAccessConfigured(): boolean {
  try {
    if (!configuredHardwarePolicy().enabled) return false;
    relyingParty();
    return true;
  } catch {
    return false;
  }
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

function parseAuthenticatorVersion(value: unknown, source: string): number {
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

function decodeCanonicalBase64Certificate(encoded: unknown): Uint8Array {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > FIDO_MDS_MAX_CERTIFICATE_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new Error('Der FIDO-MDS-Header enthält kein gültiges Zertifikat');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (
    decoded.length === 0 ||
    decoded.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) {
    throw new Error('Der FIDO-MDS-Header enthält kein kanonisches Zertifikat');
  }
  return Uint8Array.from(decoded);
}

function hasExactSubjectField(
  certificate: X509Certificate,
  field: 'CN' | 'O',
  expected: string,
): boolean {
  const values = certificate.subjectName.getField(field);
  return values.length === 1 && values[0] === expected;
}

function parseFidoMdsSignerCertificates(blob: string): X509Certificate[] {
  const parts = blob.split('.');
  const encodedHeader = parts[0];
  if (
    parts.length !== 3 ||
    !encodedHeader ||
    encodedHeader.length > FIDO_MDS_MAX_HEADER_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedHeader)
  ) {
    throw new Error('Der FIDO-MDS-BLOB besitzt keinen gültigen geschützten JWT-Header');
  }
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error('Der FIDO-MDS-BLOB besitzt keinen lesbaren JWT-Header', { cause: error });
  }
  if (!header || typeof header !== 'object') {
    throw new Error('Der FIDO-MDS-BLOB besitzt keinen strukturierten JWT-Header');
  }
  const protectedHeader = header as { alg?: unknown; x5c?: unknown };
  if (
    protectedHeader.alg !== 'RS256' ||
    !Array.isArray(protectedHeader.x5c) ||
    protectedHeader.x5c.length < 2 ||
    protectedHeader.x5c.length > 5
  ) {
    throw new Error('Der FIDO-MDS-BLOB besitzt keine zulässige Signatur-Zertifikatskette');
  }
  return protectedHeader.x5c.map((encoded) => {
    const bytes = decodeCanonicalBase64Certificate(encoded);
    return new X509Certificate(Uint8Array.from(bytes).buffer);
  });
}

function assertFidoMdsLeafSignerIdentity(leaf: X509Certificate): void {
  const san = leaf.getExtension(SubjectAlternativeNameExtension);
  const eku = leaf.getExtension(ExtendedKeyUsageExtension);
  const keyUsage = leaf.getExtension(KeyUsagesExtension);
  const basicConstraints = leaf.getExtension(BasicConstraintsExtension);
  const dnsNames = san?.names.items.filter((name) => name.type === 'dns').map((name) => name.value);
  if (
    !hasExactSubjectField(leaf, 'CN', FIDO_MDS_SIGNER_HOSTNAME) ||
    !hasExactSubjectField(leaf, 'O', FIDO_MDS_SIGNER_ORGANIZATION) ||
    dnsNames?.length !== 1 ||
    dnsNames[0] !== FIDO_MDS_SIGNER_HOSTNAME ||
    !eku?.usages.includes(ExtendedKeyUsage.serverAuth) ||
    !keyUsage ||
    (keyUsage.usages & KeyUsageFlags.digitalSignature) === 0 ||
    !basicConstraints ||
    basicConstraints.ca
  ) {
    throw new Error('Die Identität des FIDO-MDS-Signers ist nicht freigegeben');
  }
}

function assertFidoMdsIntermediateSignerIdentity(intermediate: X509Certificate): void {
  const basicConstraints = intermediate.getExtension(BasicConstraintsExtension);
  const keyUsage = intermediate.getExtension(KeyUsagesExtension);
  if (
    !hasExactSubjectField(intermediate, 'CN', FIDO_MDS_SIGNER_INTERMEDIATE_CN) ||
    !hasExactSubjectField(intermediate, 'O', FIDO_MDS_SIGNER_INTERMEDIATE_ORGANIZATION) ||
    !basicConstraints?.ca ||
    !basicConstraints.critical ||
    !keyUsage ||
    (keyUsage.usages & KeyUsageFlags.keyCertSign) === 0 ||
    (keyUsage.usages & KeyUsageFlags.cRLSign) === 0
  ) {
    throw new Error('Die Identität des FIDO-MDS-Signers ist nicht freigegeben');
  }
}

function assertFidoMdsSignerIdentity(blob: string): void {
  const certificates = parseFidoMdsSignerCertificates(blob);
  assertFidoMdsLeafSignerIdentity(certificates[0]!);
  assertFidoMdsIntermediateSignerIdentity(certificates[1]!);
}

function parseAttestationCertificate(attestationCertificate: unknown): X509Certificate {
  if (
    !(attestationCertificate instanceof Uint8Array) &&
    !(attestationCertificate instanceof ArrayBuffer)
  ) {
    throw new HardwareAccessVerificationError(
      'Die Hardware-Attestation enthält kein auswertbares Gerätezertifikat.',
    );
  }
  const certificateBytes =
    attestationCertificate instanceof ArrayBuffer
      ? attestationCertificate
      : Uint8Array.from(attestationCertificate).buffer;
  if (
    certificateBytes.byteLength === 0 ||
    certificateBytes.byteLength > ATTESTATION_CERTIFICATE_MAX_BYTES
  ) {
    throw new HardwareAccessVerificationError(
      'Die Hardware-Attestation enthält kein zulässiges Gerätezertifikat.',
    );
  }
  return new X509Certificate(certificateBytes);
}

function extractAttestedAaguid(certificate: X509Certificate): string {
  const extension = certificate.getExtension(FIDO_AAGUID_OID);
  if (!extension || extension.critical) {
    throw new HardwareAccessVerificationError(
      'Der Sicherheitsschlüssel bindet seine AAGUID nicht an das Attestationszertifikat.',
    );
  }
  const encoded = new Uint8Array(extension.value);
  if (encoded.length !== 18 || encoded[0] !== 0x04 || encoded[1] !== 0x10) {
    throw new HardwareAccessVerificationError(
      'Die attestierte AAGUID des Sicherheitsschlüssels ist ungültig.',
    );
  }
  const hex = Buffer.from(encoded.subarray(2)).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extractAttestedAuthenticatorVersion(attestationCertificate: unknown): number {
  const certificate =
    attestationCertificate instanceof X509Certificate
      ? attestationCertificate
      : parseAttestationCertificate(attestationCertificate);
  const extension = certificate.getExtension(FIDO_FIRMWARE_VERSION_OID);
  if (!extension || extension.critical) {
    throw new HardwareAccessVerificationError(
      'Der Sicherheitsschlüssel weist seine Firmware-Version nicht belastbar nach.',
    );
  }
  const encoded = new Uint8Array(extension.value);
  const length = encoded[1];
  if (
    encoded[0] !== 0x02 ||
    length === undefined ||
    length < 1 ||
    length > 5 ||
    length !== encoded.length - 2 ||
    (encoded[2]! & 0x80) !== 0 ||
    (length > 1 && encoded[2] === 0 && (encoded[3]! & 0x80) === 0)
  ) {
    throw new HardwareAccessVerificationError(
      'Die attestierte Firmware-Version des Sicherheitsschlüssels ist ungültig.',
    );
  }
  let version = 0;
  for (const byte of encoded.subarray(2)) version = version * 256 + byte;
  return parseAuthenticatorVersion(version, 'attestierte Firmware-Version');
}

async function readLimitedMdsBlob(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > FIDO_MDS_MAX_BLOB_BYTES
    ) {
      throw new Error('FIDO-MDS-BLOB überschreitet die Größenbegrenzung');
    }
  }
  let bytes: Uint8Array;
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > FIDO_MDS_MAX_BLOB_BYTES) {
      throw new Error('FIDO-MDS-BLOB überschreitet die Größenbegrenzung');
    }
    bytes = buffer;
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > FIDO_MDS_MAX_BLOB_BYTES) {
          await reader.cancel();
          throw new Error('FIDO-MDS-BLOB überschreitet die Größenbegrenzung');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const blob = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!blob) throw new Error('FIDO-MDS-BLOB ist leer');
  return blob;
}

async function claimHardwareMetadataSerial(
  serial: number,
  nextUpdate: Date,
  policy: HardwarePolicyBinding,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const rows = await prismaOwner.$queryRaw<
    Array<{ blob_serial: bigint; policy_revision: bigint; policy_hash: string }>
  >`
    INSERT INTO public."fido_mds_trust_state" (
      "singleton", "blob_serial", "next_update", "verified_at",
      "policy_revision", "policy_hash"
    ) VALUES (
      TRUE, ${BigInt(serial)}, ${nextUpdate}::date, CURRENT_TIMESTAMP,
      ${policy.revision}, ${policy.hash}
    )
    ON CONFLICT ("singleton") DO UPDATE
      SET "blob_serial" = EXCLUDED."blob_serial",
          "next_update" = EXCLUDED."next_update",
          "verified_at" = EXCLUDED."verified_at",
          "policy_revision" = EXCLUDED."policy_revision",
          "policy_hash" = EXCLUDED."policy_hash"
      WHERE public."fido_mds_trust_state"."blob_serial" <= EXCLUDED."blob_serial"
        AND (
          public."fido_mds_trust_state"."policy_revision" < EXCLUDED."policy_revision"
          OR (
            public."fido_mds_trust_state"."policy_revision" = EXCLUDED."policy_revision"
            AND public."fido_mds_trust_state"."policy_hash" = EXCLUDED."policy_hash"
          )
        )
    RETURNING "blob_serial", "policy_revision", "policy_hash"
  `;
  signal.throwIfAborted();
  if (
    rows[0]?.blob_serial !== BigInt(serial) ||
    rows[0]?.policy_revision !== policy.revision ||
    rows[0]?.policy_hash !== policy.hash
  ) {
    throw new Error(
      'Der FIDO-Vertrauensstand oder die Hardware-Policy ist älter als der persistente Stand',
    );
  }
}

async function currentHardwareMetadataState(): Promise<{
  blobSerial: bigint;
  policyRevision: bigint;
  policyHash: string;
}> {
  const rows = await prismaOwner.$queryRaw<
    Array<{ blob_serial: bigint; policy_revision: bigint; policy_hash: string }>
  >`
    SELECT "blob_serial", "policy_revision", "policy_hash"
    FROM public."fido_mds_trust_state"
    WHERE "singleton" = TRUE
    LIMIT 1
  `;
  if (!rows[0]) throw new Error('Der persistente FIDO-MDS-Vertrauensanker fehlt');
  return {
    blobSerial: rows[0].blob_serial,
    policyRevision: rows[0].policy_revision,
    policyHash: rows[0].policy_hash,
  };
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
 * Lädt und verifiziert den vollständigen signierten FIDO-MDS-BLOB selbst. Das
 * ist erforderlich, weil SimpleWebAuthn getStatement() nur das Statement,
 * nicht aber dessen übergeordneten Zertifizierungs-/Sperrstatus zurückgibt.
 * Anschließend bekommt SimpleWebAuthn ausschließlich die positiv geprüften
 * Statements für seine Attestationsketten-Prüfung.
 */
async function loadHardwareMetadataSnapshotBeforeDeadline(
  signal: AbortSignal,
): Promise<HardwareMetadataSnapshot> {
  const policy = configuredHardwarePolicy();
  const allowlist = policy.aaguids;
  const response = await fetch(FIDO_MDS_URL, {
    cache: 'no-store',
    headers: { accept: 'application/jwt' },
    signal,
  });
  if (!response.ok) throw new Error(`FIDO MDS antwortet mit HTTP ${response.status}`);
  const blob = await readLimitedMdsBlob(response);
  assertFidoMdsSignerIdentity(blob);
  const verified = await verifyMDSBlob(blob, { signal });
  if (!Number.isSafeInteger(verified.payload.no) || verified.payload.no <= 0) {
    throw new Error('Der signierte FIDO-MDS-BLOB besitzt keine gültige fortlaufende Version');
  }
  if (
    !(verified.parsedNextUpdate instanceof Date) ||
    !Number.isFinite(verified.parsedNextUpdate.getTime()) ||
    verified.parsedNextUpdate.getTime() <= Date.now()
  ) {
    throw new Error('Der signierte FIDO-MDS-BLOB ist abgelaufen');
  }

  // Der kryptografisch bestätigte globale Vertrauensstand muss auch dann
  // sofort prozessübergreifend sichtbar werden, wenn die lokale Allowlist aus
  // diesem BLOB anschließend kein noch zulässiges Schlüsselmodell übernehmen
  // kann. Sonst könnten andere Prozesse ihren älteren Cache weiter committen.
  signal.throwIfAborted();
  await claimHardwareMetadataSerial(verified.payload.no, verified.parsedNextUpdate, policy, signal);

  const byAaguid = new Map(
    verified.payload.entries
      .filter((entry): entry is MetadataBLOBPayloadEntry & { aaguid: string } => !!entry.aaguid)
      .map((entry) => [entry.aaguid.toLowerCase(), entry]),
  );
  const entries = new Map<string, MetadataBLOBPayloadEntry>();
  const statements: MetadataStatement[] = [];
  for (const aaguid of allowlist) {
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

  signal.throwIfAborted();
  await MetadataService.initialize({
    mdsServers: [],
    statements,
    verificationMode: 'strict',
  });
  signal.throwIfAborted();
  for (const aaguid of entries.keys()) {
    try {
      const statement = await MetadataService.getStatement(aaguid);
      if (!statement) throw new Error(`Keine prüfbare FIDO-Attestation für AAGUID ${aaguid}`);
      assertTrustedHardwareStatement(aaguid, statement);
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
    nextUpdate: verified.parsedNextUpdate,
    serial: verified.payload.no,
    verifiedAt: new Date(),
  };
}

async function loadHardwareMetadataSnapshot(): Promise<HardwareMetadataSnapshot> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Zeitlimit der FIDO-Metadatenprüfung überschritten'));
    }, FIDO_MDS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      loadHardwareMetadataSnapshotBeforeDeadline(controller.signal),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function ensureHardwareMetadataReady(): Promise<HardwareMetadataSnapshot> {
  const configuredPolicy = configuredHardwarePolicy();
  await claimHardwarePolicyBinding(configuredPolicy);
  if (!configuredPolicy.enabled) {
    throw new HardwareAccessUnavailableError('Der Hardware-Zugang ist zentral deaktiviert.');
  }
  while (true) {
    let pending = hardwareMetadataReadiness;
    if (!pending) {
      pending = loadHardwareMetadataSnapshot();
      hardwareMetadataReadiness = pending;
    }
    try {
      const snapshot = await pending;
      const now = Date.now();
      const persistedState = await currentHardwareMetadataState();
      const policy = configuredHardwarePolicy();
      if (
        snapshot.nextUpdate.getTime() > now &&
        now - snapshot.verifiedAt.getTime() <= FIDO_MDS_MAX_SNAPSHOT_AGE_MS &&
        BigInt(snapshot.serial) === persistedState.blobSerial &&
        policy.revision === persistedState.policyRevision &&
        policy.hash === persistedState.policyHash
      ) {
        return snapshot;
      }
      if (hardwareMetadataReadiness === pending) hardwareMetadataReadiness = null;
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
}

async function currentTrustedHardwareStatement(
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
    const statement = await MetadataService.getStatement(normalized);
    if (!statement) throw new Error(`Keine FIDO-Metadaten für AAGUID ${normalized}`);
    assertTrustedHardwareStatement(normalized, statement);
    return { statement, metadataSerial: BigInt(snapshot.serial) };
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

function relyingParty(): { origin: string; rpID: string } {
  const configured = new URL(env.NEXTAUTH_URL);
  const hostname = configured.hostname.replace(/^\[|\]$/g, '');
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (configured.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && local)) {
    throw new HardwareAccessUnavailableError(
      'Sicherheitsschlüssel benötigen eine konfigurierte HTTPS-Adresse.',
    );
  }
  return { origin: configured.origin, rpID: hostname };
}

function ceremonyKey(id: string): string {
  return `staff-webauthn:ceremony:${id}`;
}

async function storeCeremony(
  value: Omit<HardwareCeremony, 'version' | 'origin' | 'rpID'>,
): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new HardwareAccessUnavailableError();
  const id = randomBytes(24).toString('base64url');
  const rp = relyingParty();
  const ceremony: HardwareCeremony = { version: 1, ...value, ...rp };
  try {
    const stored = await redis.set(
      ceremonyKey(id),
      JSON.stringify(ceremony),
      'EX',
      CEREMONY_TTL_SECONDS,
      'NX',
    );
    if (stored !== 'OK') throw new Error('ceremony id collision');
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'WebAuthn-Zeremonie konnte nicht gespeichert werden',
    );
    throw new HardwareAccessUnavailableError(undefined, { cause: error });
  }
  return id;
}

const CONSUME_CEREMONY_LUA = `
local value = redis.call('GET', KEYS[1])
if not value then
  return false
end
redis.call('DEL', KEYS[1])
return value
`;

export async function consumeHardwareCeremony(input: {
  ceremonyId: string;
  purpose: HardwareCeremonyPurpose;
  staffId?: string;
  tenantId?: string;
  targetStaffId?: string;
  authRevision?: number;
}): Promise<HardwareCeremony> {
  if (!CEREMONY_ID_PATTERN.test(input.ceremonyId)) {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }
  const redis = getRedis();
  if (!redis) throw new HardwareAccessUnavailableError();

  let raw: unknown;
  try {
    raw = await redis.eval(CONSUME_CEREMONY_LUA, 1, ceremonyKey(input.ceremonyId));
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'WebAuthn-Zeremonie konnte nicht verbraucht werden',
    );
    throw new HardwareAccessUnavailableError(undefined, { cause: error });
  }
  if (typeof raw !== 'string') {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }
  if (!value || typeof value !== 'object') {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }
  const ceremony = value as Partial<HardwareCeremony>;
  const rp = relyingParty();
  if (
    ceremony.version !== 1 ||
    ceremony.purpose !== input.purpose ||
    typeof ceremony.challenge !== 'string' ||
    ceremony.origin !== rp.origin ||
    ceremony.rpID !== rp.rpID ||
    ceremony.staffId !== input.staffId ||
    ceremony.tenantId !== input.tenantId ||
    ceremony.targetStaffId !== input.targetStaffId ||
    ceremony.authRevision !== input.authRevision
  ) {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage passt nicht zu diesem Vorgang.',
    );
  }
  return ceremony as HardwareCeremony;
}

export async function beginHardwareLogin(): Promise<{
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  // Die Vertrauenskette wird vor dem Browser-Prompt geladen. Bei deaktivierter
  // Policy oder nicht erreichbarer MDS startet dadurch keine nutzlose
  // Discoverable-Credential-Zeremonie.
  await ensureHardwareMetadataReady();
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60_000,
    userVerification: 'required',
  });
  const ceremonyId = await storeCeremony({ purpose: 'login', challenge: options.challenge });
  return { ceremonyId, options };
}

export async function beginHardwareRegistration(input: {
  staffId: string;
  tenantId: string;
  authRevision: number;
  email: string;
  fullName: string;
  existingCredentials: Array<{ credentialId: string; transports: string[] }>;
}): Promise<{
  ceremonyId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}> {
  await ensureHardwareMetadataReady();
  const { rpID } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: 'Kanzleikonsole',
    rpID,
    userID: new Uint8Array(Buffer.from(input.staffId, 'utf8')),
    userName: input.email,
    userDisplayName: input.fullName,
    timeout: 60_000,
    attestationType: 'direct',
    excludeCredentials: input.existingCredentials.map((credential) => ({
      id: credential.credentialId,
      transports: parseTransports(credential.transports),
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'cross-platform',
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    preferredAuthenticatorType: 'securityKey',
  });
  const ceremonyId = await storeCeremony({
    purpose: 'register',
    challenge: options.challenge,
    staffId: input.staffId,
    tenantId: input.tenantId,
    authRevision: input.authRevision,
  });
  return { ceremonyId, options };
}

export async function beginHardwareModeAssertion(input: {
  purpose: 'mode-enable' | 'mode-disable' | 'admin-recovery';
  staffId: string;
  tenantId: string;
  targetStaffId?: string;
  authRevision?: number;
  credentials: Array<{ credentialId: string; transports: string[] }>;
}): Promise<{
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials: input.credentials.map((credential) => ({
      id: credential.credentialId,
      transports: parseTransports(credential.transports),
    })),
  });
  const ceremonyId = await storeCeremony({
    purpose: input.purpose,
    challenge: options.challenge,
    staffId: input.staffId,
    tenantId: input.tenantId,
    targetStaffId: input.targetStaffId,
    authRevision: input.authRevision,
  });
  return { ceremonyId, options };
}

const PHYSICAL_TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  'ble',
  'nfc',
  'smart-card',
  'usb',
]);
const NON_HARDWARE_TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  'cable',
  'hybrid',
  'internal',
]);

export function parseTransports(values: readonly string[]): AuthenticatorTransportFuture[] {
  const valid: AuthenticatorTransportFuture[] = [
    'ble',
    'cable',
    'hybrid',
    'internal',
    'nfc',
    'smart-card',
    'usb',
  ];
  const allowed = new Set(valid);
  return Array.from(
    new Set(
      values.filter((value): value is AuthenticatorTransportFuture =>
        allowed.has(value as AuthenticatorTransportFuture),
      ),
    ),
  );
}

function assertPhysicalAuthenticator(
  attachment: AuthenticationResponseJSON['authenticatorAttachment'],
  transports: readonly AuthenticatorTransportFuture[],
  deviceType: string,
  backedUp: boolean,
  requireAttachment: boolean,
): void {
  if (
    (requireAttachment ? attachment !== 'cross-platform' : attachment === 'platform') ||
    deviceType !== 'singleDevice' ||
    backedUp
  ) {
    throw new HardwareAccessVerificationError(
      'Bitte verwenden Sie einen gerätegebundenen physischen FIDO2-Sicherheitsschlüssel.',
    );
  }
  if (
    transports.length === 0 ||
    !transports.some((transport) => PHYSICAL_TRANSPORTS.has(transport)) ||
    transports.some((transport) => NON_HARDWARE_TRANSPORTS.has(transport))
  ) {
    throw new HardwareAccessVerificationError(
      'Der Authentikator wurde nicht als physischer Sicherheitsschlüssel erkannt.',
    );
  }
}

function preflightPackedAttestation(response: RegistrationResponseJSON): unknown {
  let serializedLength: number;
  try {
    serializedLength = Buffer.byteLength(JSON.stringify(response), 'utf8');
  } catch {
    throw new HardwareAccessVerificationError('Die Hardware-Attestation ist nicht lesbar.');
  }
  const encodedAttestation = response.response.attestationObject;
  if (
    serializedLength > REGISTRATION_RESPONSE_JSON_MAX_CHARS ||
    typeof encodedAttestation !== 'string' ||
    encodedAttestation.length === 0 ||
    encodedAttestation.length > ATTESTATION_OBJECT_MAX_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedAttestation)
  ) {
    throw new HardwareAccessVerificationError(
      'Die Hardware-Attestation ist zu groß oder ungültig.',
    );
  }
  const transports = parseTransports(response.response.transports ?? []);
  assertPhysicalAuthenticator(
    response.authenticatorAttachment,
    transports,
    'singleDevice',
    false,
    true,
  );
  let decoded;
  try {
    decoded = decodeAttestationObject(new Uint8Array(Buffer.from(encodedAttestation, 'base64url')));
  } catch (error) {
    throw new HardwareAccessVerificationError('Die Hardware-Attestation ist nicht lesbar.', {
      cause: error,
    });
  }
  const statement = decoded.get('attStmt');
  const certificateChain = statement?.get('x5c');
  if (
    decoded.get('fmt') !== 'packed' ||
    !Array.isArray(certificateChain) ||
    certificateChain.length === 0 ||
    certificateChain.length > ATTESTATION_CERTIFICATE_CHAIN_MAX
  ) {
    throw new HardwareAccessVerificationError(
      'Der Schlüssel liefert keine vollständige freigegebene Hardware-Attestation.',
    );
  }
  let totalCertificateBytes = 0;
  for (const certificate of certificateChain as unknown[]) {
    if (!(certificate instanceof Uint8Array) && !(certificate instanceof ArrayBuffer)) {
      throw new HardwareAccessVerificationError('Die Attestationszertifikatskette ist ungültig.');
    }
    const byteLength = certificate.byteLength;
    if (byteLength === 0 || byteLength > ATTESTATION_CERTIFICATE_MAX_BYTES) {
      throw new HardwareAccessVerificationError('Die Attestationszertifikatskette ist ungültig.');
    }
    totalCertificateBytes += byteLength;
  }
  if (
    totalCertificateBytes >
    ATTESTATION_CERTIFICATE_MAX_BYTES * ATTESTATION_CERTIFICATE_CHAIN_MAX
  ) {
    throw new HardwareAccessVerificationError('Die Attestationszertifikatskette ist zu groß.');
  }
  return certificateChain[0];
}

async function verifyRegistrationBeforeDeadline(input: {
  response: RegistrationResponseJSON;
  ceremony: HardwareCeremony;
}) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Zeitlimit der Hardware-Attestationsprüfung überschritten');
      controller.abort(error);
      reject(error);
    }, FIDO_ATTESTATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: input.ceremony.challenge,
        expectedOrigin: input.ceremony.origin,
        expectedRPID: input.ceremony.rpID,
        requireUserPresence: true,
        requireUserVerification: true,
        signal: controller.signal,
      }),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function verifyHardwareRegistration(input: {
  response: RegistrationResponseJSON;
  ceremony: HardwareCeremony;
}): Promise<VerifiedHardwareRegistration> {
  const attestationCertificateBytes = preflightPackedAttestation(input.response);
  const attestationSnapshot = await ensureHardwareMetadataReady();
  let result;
  try {
    result = await verifyRegistrationBeforeDeadline(input);
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'WebAuthn-Registrierung abgewiesen',
    );
    throw new HardwareAccessVerificationError();
  }
  if (!result.verified || !result.registrationInfo.userVerified) {
    throw new HardwareAccessVerificationError();
  }
  const aaguid = result.registrationInfo.aaguid.toLowerCase();
  let authenticatorVersion: number;
  let metadataSerial: bigint;
  try {
    if (result.registrationInfo.fmt !== 'packed') {
      throw new HardwareAccessVerificationError(
        'Der Schlüssel liefert keine vollständige freigegebene Hardware-Attestation.',
      );
    }
    const certificate = parseAttestationCertificate(attestationCertificateBytes);
    if (extractAttestedAaguid(certificate) !== aaguid) {
      throw new HardwareAccessVerificationError(
        'Die AAGUID des Schlüssels passt nicht zu seinem Attestationszertifikat.',
      );
    }
    authenticatorVersion = extractAttestedAuthenticatorVersion(certificate);
    ({ metadataSerial } = await currentTrustedHardwareStatement(aaguid, authenticatorVersion));
    if (metadataSerial !== BigInt(attestationSnapshot.serial)) {
      throw new HardwareAccessUnavailableError(
        'Der FIDO-Vertrauensstand wurde während der Attestationsprüfung aktualisiert. Bitte wiederholen Sie den Vorgang.',
      );
    }
  } catch (error) {
    if (
      error instanceof HardwareAccessUnavailableError ||
      error instanceof HardwareAccessVerificationError
    ) {
      throw error;
    }
    log.warn(
      { component: 'staff-webauthn', aaguid, err: (error as Error).message },
      'Hardware-Attestation konnte nicht ausgewertet werden',
    );
    throw new HardwareAccessVerificationError();
  }
  const transports = parseTransports(input.response.response.transports ?? []);
  assertPhysicalAuthenticator(
    input.response.authenticatorAttachment,
    transports,
    result.registrationInfo.credentialDeviceType,
    result.registrationInfo.credentialBackedUp,
    true,
  );
  return {
    credentialId: result.registrationInfo.credential.id,
    publicKey: result.registrationInfo.credential.publicKey,
    signCount: BigInt(result.registrationInfo.credential.counter),
    transports,
    deviceType: 'singleDevice',
    backedUp: false,
    attestationFormat: 'packed',
    attestationVerifiedAt: new Date(),
    aaguid,
    authenticatorVersion: BigInt(authenticatorVersion),
    metadataSerial,
  };
}

export async function verifyHardwareAssertion(input: {
  response: AuthenticationResponseJSON;
  ceremony: HardwareCeremony;
  credential: StoredHardwareCredential;
  staffId: string;
  requireUserHandle?: boolean;
}): Promise<VerifiedHardwareAssertion> {
  const { transports, metadataSerial } = await assertStoredHardwareCredentialTrusted(
    input.credential,
  );
  assertPhysicalAuthenticator(
    input.response.authenticatorAttachment,
    transports,
    input.credential.deviceType,
    input.credential.backedUp,
    false,
  );
  const expectedUserHandle = Buffer.from(input.staffId, 'utf8').toString('base64url');
  if (
    input.credential.webauthnUserId !== expectedUserHandle ||
    (input.requireUserHandle && input.response.response.userHandle !== expectedUserHandle) ||
    (input.response.response.userHandle !== undefined &&
      input.response.response.userHandle !== expectedUserHandle)
  ) {
    throw new HardwareAccessVerificationError(
      'Der Sicherheitsschlüssel gehört nicht zu diesem Konto.',
    );
  }
  const counter = Number(input.credential.signCount);
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new HardwareAccessVerificationError();
  }

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.ceremony.challenge,
      expectedOrigin: input.ceremony.origin,
      expectedRPID: input.ceremony.rpID,
      credential: {
        id: input.credential.id,
        publicKey: new Uint8Array(input.credential.publicKey),
        counter,
        transports,
      },
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    });
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'WebAuthn-Assertion abgewiesen',
    );
    throw new HardwareAccessVerificationError();
  }
  if (
    !result.verified ||
    !result.authenticationInfo.userVerified ||
    result.authenticationInfo.credentialDeviceType !== 'singleDevice' ||
    result.authenticationInfo.credentialBackedUp
  ) {
    throw new HardwareAccessVerificationError();
  }
  return {
    newSignCount: BigInt(result.authenticationInfo.newCounter),
    metadataSerial,
  };
}

export async function assertStoredHardwareCredentialTrusted(
  credential: HardwareCredentialTrustInput,
): Promise<{ transports: AuthenticatorTransportFuture[]; metadataSerial: bigint }> {
  if (
    !credential.aaguid ||
    credential.authenticatorVersion === null ||
    credential.attestationFormat !== 'packed' ||
    !credential.attestationVerifiedAt
  ) {
    throw new HardwareAccessVerificationError(
      'Für diesen Schlüssel fehlt ein verifizierter Hardware-Nachweis.',
    );
  }
  // Die Freigabe gilt nicht nur zum Registrierungszeitpunkt. Ein Modell, das
  // später aus der Deployment-Allowlist entfernt oder durch den FIDO MDS als
  // nicht mehr vertrauenswürdig bewertet wird, darf sich ab diesem Zeitpunkt
  // auch mit einem bereits gespeicherten Credential nicht mehr anmelden.
  if (
    typeof credential.authenticatorVersion !== 'bigint' ||
    credential.authenticatorVersion < 0n ||
    credential.authenticatorVersion > BigInt(MAX_AUTHENTICATOR_VERSION)
  ) {
    throw new HardwareAccessVerificationError(
      'Für diesen Schlüssel fehlt eine gültige attestierte Firmware-Version.',
    );
  }
  const { metadataSerial } = await currentTrustedHardwareStatement(
    credential.aaguid,
    Number(credential.authenticatorVersion),
  );
  const transports = parseTransports(credential.transports);
  assertPhysicalAuthenticator(
    undefined,
    transports,
    credential.deviceType,
    credential.backedUp,
    false,
  );
  return { transports, metadataSerial };
}

export function parseAuthenticationResponse(raw: string): AuthenticationResponseJSON {
  if (!raw || raw.length > RESPONSE_JSON_MAX_CHARS) throw new HardwareAccessVerificationError();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HardwareAccessVerificationError();
  }
  if (!value || typeof value !== 'object') throw new HardwareAccessVerificationError();
  const response = value as Partial<AuthenticationResponseJSON>;
  if (
    typeof response.id !== 'string' ||
    response.id.length < 16 ||
    response.id.length > 2048 ||
    response.type !== 'public-key' ||
    !response.response ||
    typeof response.response.clientDataJSON !== 'string' ||
    typeof response.response.authenticatorData !== 'string' ||
    typeof response.response.signature !== 'string'
  ) {
    throw new HardwareAccessVerificationError();
  }
  return response as AuthenticationResponseJSON;
}

export function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<RegistrationResponseJSON>;
  return (
    typeof response.id === 'string' &&
    response.id.length >= 16 &&
    response.id.length <= 2048 &&
    response.type === 'public-key' &&
    !!response.response &&
    typeof response.response.clientDataJSON === 'string' &&
    typeof response.response.attestationObject === 'string'
  );
}

export function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (!value || typeof value !== 'object') return false;
  try {
    parseAuthenticationResponse(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

async function recordKnownHardwareLoginFailure(input: {
  tenantId: string;
  staffUserId: string;
  ip: string | null;
}): Promise<void> {
  try {
    await prismaOwner.$transaction(async (tx) => {
      await evidenceService.record(tx, {
        tenantId: input.tenantId,
        actorType: 'STAFF',
        actorId: input.staffUserId,
        action: 'auth.login.failure',
        resourceType: 'staff_user',
        resourceId: input.staffUserId,
        // Absichtlich generisch: weder Credential-ID noch AAGUID, E-Mail oder
        // Verifikationsdetail duerfen zu einem Enumerations-/Geheimnisleck werden.
        after: { method: 'security_key', reason: 'security_key' },
        ip: auditIp(input.ip),
      });
    });
  } catch {
    // Eine nicht verfuegbare Audit-DB darf die ohnehin abgewiesene Anmeldung
    // weder erfolgreich machen noch mit einem unterscheidbaren Fehler versehen.
    log.warn(
      { component: 'staff-webauthn' },
      'Abgewiesene Hardware-Anmeldung konnte nicht auditiert werden',
    );
  }
}

export async function authenticateStaffHardwareCredential(input: {
  ceremonyId: string;
  responseJson: string;
  ip: string | null;
}): Promise<HardwareLoginUser | null> {
  const ceremony = await consumeHardwareCeremony({
    ceremonyId: input.ceremonyId,
    purpose: 'login',
  });
  const response = parseAuthenticationResponse(input.responseJson);
  const credential = await prismaOwner.staffWebAuthnCredential.findUnique({
    where: { credentialId: response.id },
    include: {
      staffUser: {
        include: { roles: true, permissions: true },
      },
    },
  });
  if (!credential) return null;
  if (
    credential.revokedAt ||
    !credential.aaguid ||
    credential.authenticatorVersion === null ||
    !credential.attestationVerifiedAt ||
    credential.attestationFormat !== 'packed' ||
    !credential.staffUser.active ||
    !credential.staffUser.hardwareOnlyEnabledAt ||
    (credential.staffUser.lockedUntil && credential.staffUser.lockedUntil > new Date())
  ) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    return null;
  }

  let assertion: VerifiedHardwareAssertion;
  try {
    assertion = await verifyHardwareAssertion({
      response,
      ceremony,
      credential: {
        id: credential.credentialId,
        aaguid: credential.aaguid,
        publicKey: credential.publicKey,
        signCount: credential.signCount,
        webauthnUserId: credential.webauthnUserId,
        transports: credential.transports,
        deviceType: credential.deviceType,
        backedUp: credential.backedUp,
        attestationFormat: credential.attestationFormat,
        attestationVerifiedAt: credential.attestationVerifiedAt,
        authenticatorVersion: credential.authenticatorVersion,
      },
      staffId: credential.staffUserId,
      requireUserHandle: true,
    });
  } catch (error) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    throw error;
  }

  const now = new Date();
  let committed: boolean;
  try {
    committed = await prismaOwner.$transaction(async (tx) => {
      await lockMatchingHardwareMetadataSerial(tx, assertion.metadataSerial);
      const keyUpdated = await tx.staffWebAuthnCredential.updateMany({
        where: {
          id: credential.id,
          tenantId: credential.tenantId,
          staffUserId: credential.staffUserId,
          revokedAt: null,
          signCount: credential.signCount,
        },
        data: { signCount: assertion.newSignCount, lastUsedAt: now },
      });
      if (keyUpdated.count !== 1) return false;
      const userUpdated = await tx.staffUser.updateMany({
        where: {
          id: credential.staffUserId,
          tenantId: credential.tenantId,
          active: true,
          hardwareOnlyEnabledAt: { not: null },
          authRevision: credential.staffUser.authRevision,
        },
        data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
      });
      // Das Counter-Update muss mit dem Konto-CAS atomar bleiben. Ein bloßes
      // `return false` würde die Transaktion committen und bei einem parallelen
      // Modus-/Revisionwechsel nur den Schlüsselzähler fortschreiben.
      if (userUpdated.count !== 1) throw new HardwareAccessVerificationError();
      await evidenceService.record(tx, {
        tenantId: credential.tenantId,
        actorType: 'STAFF',
        actorId: credential.staffUserId,
        action: 'auth.login.success',
        resourceType: 'staff_user',
        resourceId: credential.staffUserId,
        after: { email: credential.staffUser.email, method: 'security_key' },
        ip: auditIp(input.ip),
      });
      return true;
    });
  } catch (error) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    throw error;
  }
  if (!committed) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    return null;
  }

  return {
    id: credential.staffUser.id,
    email: credential.staffUser.email,
    name: credential.staffUser.fullName,
    staffId: credential.staffUser.id,
    tenantId: credential.tenantId,
    fullName: credential.staffUser.fullName,
    roles: credential.staffUser.roles.map((role) => role.role as string),
    permissions: credential.staffUser.permissions.map(
      (permission) => permission.permission as string,
    ),
    authMethod: 'security_key',
    authRevision: credential.staffUser.authRevision,
  };
}
