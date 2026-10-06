// =============================================================================
// Verifikation von Hardware-Registrierungen und -Assertions (P-23: aus
// webauthn.ts gelöst)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Nur gepackte Hardware-Attestation mit an das Zertifikat gebundener AAGUID und
// Firmware-Version, physische Transporte, gerätegebundene nicht gesicherte
// Credentials, User Verification. Der Vertrauensstand des Modells stammt aus
// dem gespeicherten, signaturgeprüften MDS-Snapshot (webauthn-metadata.ts).
//
// T-02: SimpleWebAuthn prüft die Registrierung ohne Netzzugriff (Statements
// ohne Wurzeln). Danach folgen AAGUID-, Firmware- und Statusbindung und erst
// zuletzt die eigene Ketten- und Sperrlistenprüfung (webauthn-attestation.ts);
// alles zusammen unter einem 30-Sekunden-Zeitlimit mit Abbruchsignal.
// =============================================================================

import { X509Certificate } from '@peculiar/x509';
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type MetadataStatement,
  type RegistrationResponseJSON,
  type Uint8Array_,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeAttestationObject } from '@simplewebauthn/server/helpers';
import { log } from '@/server/logger';
import { assertTrustedAttestationPath, extractAttestedAaguid } from './webauthn-attestation';
import { parseTransports, type HardwareCeremony } from './webauthn-ceremony';
import {
  MAX_AUTHENTICATOR_VERSION,
  currentTrustedHardwareStatement,
  ensureHardwareMetadataReady,
  parseAuthenticatorVersion,
} from './webauthn-metadata';
import { HardwareAccessUnavailableError, HardwareAccessVerificationError } from './webauthn-shared';

const REGISTRATION_RESPONSE_JSON_MAX_CHARS = 768 * 1024;
const ATTESTATION_OBJECT_MAX_CHARS = 512 * 1024;
const ATTESTATION_CERTIFICATE_MAX_BYTES = 64 * 1024;
const ATTESTATION_CERTIFICATE_CHAIN_MAX = 5;
const FIDO_ATTESTATION_TIMEOUT_MS = 30_000;
const FIDO_FIRMWARE_VERSION_OID = '1.3.6.1.4.1.45724.1.1.5';

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

type VerifiedRegistrationInfo = Extract<
  VerifiedRegistrationResponse,
  { verified: true }
>['registrationInfo'];

/** Ergebnis der Attestationsprüfung, bevor Transporte und Gerätebindung folgen. */
type AttestedRegistration = {
  registrationInfo: VerifiedRegistrationInfo;
  aaguid: string;
  authenticatorVersion: number;
  metadataSerial: bigint;
};

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

/** Lokale Vorprüfung ohne Netzzugriff; liefert die x5c-Kette (Blatt zuerst) als Kopie. */
function preflightPackedAttestation(response: RegistrationResponseJSON): Uint8Array_[] {
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
  return (certificateChain as Array<Uint8Array | ArrayBuffer>).map(
    (certificate) => new Uint8Array(certificate),
  );
}

/**
 * Die eigene Kettenprüfung muss genau die Zertifikate prüfen, deren Blatt
 * SimpleWebAuthn für die Attestationssignatur verwendet hat.
 */
function assertLibraryVerifiedChain(
  attestationObject: Uint8Array_,
  certificateChain: readonly Uint8Array_[],
): void {
  const verifiedChain = decodeAttestationObject(attestationObject).get('attStmt')?.get('x5c');
  if (
    !Array.isArray(verifiedChain) ||
    verifiedChain.length !== certificateChain.length ||
    verifiedChain.some(
      (certificate, index) =>
        !Buffer.from(certificate).equals(Buffer.from(certificateChain[index]!)),
    )
  ) {
    throw new Error('Die verifizierte Attestationskette weicht von der Vorprüfung ab');
  }
}

/** Ein Zeitlimit und Abbruchsignal für Bibliotheks-, Bindungs- und Kettenprüfung. */
async function beforeAttestationDeadline<T>(
  verify: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
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
    return await Promise.race([verify(controller.signal), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function verifyPackedAttestation(
  input: { response: RegistrationResponseJSON; ceremony: HardwareCeremony },
  certificateChain: readonly Uint8Array_[],
  snapshotSerial: number,
  signal: AbortSignal,
): Promise<AttestedRegistration> {
  // Ohne Netzzugriff: Die Statements im MetadataService tragen keine Wurzeln.
  const result = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.ceremony.challenge,
    expectedOrigin: input.ceremony.origin,
    expectedRPID: input.ceremony.rpID,
    requireUserPresence: true,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo.userVerified) {
    throw new HardwareAccessVerificationError();
  }
  const aaguid = result.registrationInfo.aaguid.toLowerCase();
  let authenticatorVersion: number;
  let trusted: { statement: MetadataStatement; metadataSerial: bigint };
  try {
    if (result.registrationInfo.fmt !== 'packed') {
      throw new HardwareAccessVerificationError(
        'Der Schlüssel liefert keine vollständige freigegebene Hardware-Attestation.',
      );
    }
    const certificate = parseAttestationCertificate(certificateChain[0]);
    if (extractAttestedAaguid(certificate) !== aaguid) {
      throw new HardwareAccessVerificationError(
        'Die AAGUID des Schlüssels passt nicht zu seinem Attestationszertifikat.',
      );
    }
    authenticatorVersion = extractAttestedAuthenticatorVersion(certificate);
    trusted = await currentTrustedHardwareStatement(aaguid, authenticatorVersion);
    if (trusted.metadataSerial !== BigInt(snapshotSerial)) {
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
  // Erst nach AAGUID-, Firmware- und Statusbindung: Kette und Sperrlisten (Netz).
  assertLibraryVerifiedChain(result.registrationInfo.attestationObject, certificateChain);
  await assertTrustedAttestationPath({
    certificateChain,
    attestationRootCertificates: trusted.statement.attestationRootCertificates,
    signal,
  });
  return {
    registrationInfo: result.registrationInfo,
    aaguid,
    authenticatorVersion,
    metadataSerial: trusted.metadataSerial,
  };
}

export async function verifyHardwareRegistration(input: {
  response: RegistrationResponseJSON;
  ceremony: HardwareCeremony;
}): Promise<VerifiedHardwareRegistration> {
  const certificateChain = preflightPackedAttestation(input.response);
  const attestationSnapshot = await ensureHardwareMetadataReady();
  let attested: AttestedRegistration;
  try {
    attested = await beforeAttestationDeadline((signal) =>
      verifyPackedAttestation(input, certificateChain, attestationSnapshot.serial, signal),
    );
  } catch (error) {
    if (
      error instanceof HardwareAccessUnavailableError ||
      error instanceof HardwareAccessVerificationError
    ) {
      throw error;
    }
    // Bibliotheks-, Ketten-, Sperrlisten- und Zeitlimitfehler: generisch abweisen.
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'WebAuthn-Registrierung abgewiesen',
    );
    throw new HardwareAccessVerificationError();
  }
  const { registrationInfo } = attested;
  const transports = parseTransports(input.response.response.transports ?? []);
  assertPhysicalAuthenticator(
    input.response.authenticatorAttachment,
    transports,
    registrationInfo.credentialDeviceType,
    registrationInfo.credentialBackedUp,
    true,
  );
  return {
    credentialId: registrationInfo.credential.id,
    publicKey: registrationInfo.credential.publicKey,
    signCount: BigInt(registrationInfo.credential.counter),
    transports,
    deviceType: 'singleDevice',
    backedUp: false,
    attestationFormat: 'packed',
    attestationVerifiedAt: new Date(),
    aaguid: attested.aaguid,
    authenticatorVersion: BigInt(attested.authenticatorVersion),
    metadataSerial: attested.metadataSerial,
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
