// =============================================================================
// T-02: Testhilfe (kein Test) für echte Attestations-PKI: Wurzel-/Zwischen-CAs,
// Attestationszertifikate mit FIDO-Extensions, CRLs, ein CRL-Abruf-Stub und
// eine vollständige packed-Registrierungsantwort, die SimpleWebAuthn ohne
// Mocks verifiziert.
// =============================================================================

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  CRLDistributionPointsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
  X509CrlGenerator,
  type X509Certificate,
} from '@peculiar/x509';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { vi } from 'vitest';

export const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const HOUR = 3_600_000;
const FIDO_AAGUID_OID = '1.3.6.1.4.1.45724.1.1.4';
const FIDO_FIRMWARE_VERSION_OID = '1.3.6.1.4.1.45724.1.1.5';

export const RP_ID = 'kanzlei.example.test';
export const ORIGIN = 'https://kanzlei.example.test';
export const CHALLENGE = 'registration-challenge-value';

export type Authority = { certificate: X509Certificate; keys: CryptoKeyPair; crlUrl: string };
type Validity = { notBefore?: Date; notAfter?: Date };

// Erstes Byte < 0x80: X509CrlGenerator kodiert Seriennummern sonst ohne
// führendes Null-Byte, und findRevoked fände den Sperreintrag nicht.
let serial = 0x6000;
export function nextSerial(): string {
  serial += 1;
  return serial.toString(16).padStart(8, '0');
}

export async function generateKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(KEY_ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

function validity(options: Validity): { notBefore: Date; notAfter: Date } {
  return {
    notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
    notAfter: options.notAfter ?? new Date(Date.now() + HOUR),
  };
}

function crlUrlFor(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `https://crl.example.test/${slug}-${nextSerial()}.crl`;
}

async function caExtensions(keys: CryptoKeyPair, pathLength: number): Promise<Extension[]> {
  return [
    new BasicConstraintsExtension(true, pathLength, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    await SubjectKeyIdentifierExtension.create(keys.publicKey),
  ];
}

export async function createRootCA(label: string, options: Validity = {}): Promise<Authority> {
  const keys = await generateKeys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: `CN=${label} Root`,
    serialNumber: nextSerial(),
    ...validity(options),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: await caExtensions(keys, 1),
  });
  return { certificate, keys, crlUrl: crlUrlFor(`${label} root`) };
}

export async function createIntermediateCA(issuer: Authority, label: string): Promise<Authority> {
  const keys = await generateKeys();
  const certificate = await X509CertificateGenerator.create({
    subject: `CN=${label} Intermediate`,
    issuer: issuer.certificate.subject,
    serialNumber: nextSerial(),
    ...validity({}),
    publicKey: keys.publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      ...(await caExtensions(keys, 0)),
      new CRLDistributionPointsExtension([issuer.crlUrl]),
      await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey),
    ],
  });
  return { certificate, keys, crlUrl: crlUrlFor(`${label} intermediate`) };
}

function aaguidBytes(aaguid: string): Uint8Array {
  return new Uint8Array(Buffer.from(aaguid.replaceAll('-', ''), 'hex'));
}

/** FIDO-AAGUID-Extension: OCTET STRING mit genau 16 Byte. */
export function aaguidExtension(aaguid: string, critical = false): Extension {
  return new Extension(
    FIDO_AAGUID_OID,
    critical,
    new Uint8Array([0x04, 0x10, ...aaguidBytes(aaguid)]),
  );
}

export async function createAttestationCertificate(
  issuer: Authority,
  options: Validity & {
    aaguid?: string;
    aaguidExtension?: Extension | null;
    publicKey?: CryptoKey;
  } = {},
): Promise<X509Certificate> {
  const fidoExtensions: Extension[] = [
    // Firmware-Version 42 als DER-INTEGER.
    new Extension(FIDO_FIRMWARE_VERSION_OID, false, new Uint8Array([0x02, 0x01, 0x2a])),
  ];
  if (options.aaguidExtension !== null) {
    fidoExtensions.push(
      options.aaguidExtension ??
        aaguidExtension(options.aaguid ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    );
  }
  return X509CertificateGenerator.create({
    subject: `C=DE, O=Test Vendor, OU=Authenticator Attestation, CN=Test Key ${nextSerial()}`,
    issuer: issuer.certificate.subject,
    serialNumber: nextSerial(),
    ...validity(options),
    publicKey: options.publicKey ?? (await generateKeys()).publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new CRLDistributionPointsExtension([issuer.crlUrl]),
      await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey),
      ...fidoExtensions,
    ],
  });
}

export async function crlResponse(
  issuer: Authority,
  revoked: X509Certificate[] = [],
): Promise<Response> {
  const crl = await X509CrlGenerator.create({
    issuer: issuer.certificate.subject,
    thisUpdate: new Date(Date.now() - 60_000),
    nextUpdate: new Date(Date.now() + HOUR),
    entries: revoked.map((certificate) => ({
      serialNumber: certificate.serialNumber,
      revocationDate: new Date(Date.now() - 30_000),
    })),
    signingAlgorithm: SIGNING_ALGORITHM,
    signingKey: issuer.keys.privateKey,
    extensions: [await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey)],
  });
  return new Response(new Uint8Array(crl.rawData), { status: 200 });
}

/** Beantwortet Abrufe je URL; unbekannte URLs scheitern wie ein Netzfehler. */
export function stubFetch(responses: Record<string, () => Promise<Response> | Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const respond = responses[String(input)];
    if (!respond) throw new TypeError(`fetch failed: ${String(input)}`);
    return respond();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const der = (certificate: X509Certificate) => new Uint8Array(certificate.rawData);
export const base64Der = (certificate: X509Certificate) =>
  Buffer.from(certificate.rawData).toString('base64');

function concat(...parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(parts.flatMap((part) => Array.from(part)));
}

function derInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const value = Array.from(bytes.subarray(start));
  if ((value[0]! & 0x80) !== 0) value.unshift(0);
  return [0x02, value.length, ...value];
}

/** WebCrypto liefert r||s; packed verlangt eine DER-kodierte ECDSA-Signatur. */
function derEcdsaSignature(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/**
 * Vollständige packed-Registrierung (UP, UV, AT) eines P-256-Credentials,
 * attestiert mit `attestationKeys` und der Kette `certificateChain` (Blatt zuerst).
 */
export async function packedRegistrationResponse(input: {
  aaguid: string;
  attestationKeys: CryptoKeyPair;
  certificateChain: X509Certificate[];
}): Promise<RegistrationResponseJSON> {
  const credentialKeys = await generateKeys();
  const jwk = await crypto.subtle.exportKey('jwk', credentialKeys.publicKey);
  const cosePublicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]),
  );
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)),
  );
  const authData = concat(
    rpIdHash,
    [0x45], // UP | UV | AT
    [0, 0, 0, 0],
    aaguidBytes(input.aaguid),
    [0, credentialId.length],
    credentialId,
    cosePublicKey,
  );
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.create', challenge: CHALLENGE, origin: ORIGIN }),
  );
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      SIGNING_ALGORITHM,
      input.attestationKeys.privateKey,
      concat(authData, clientDataHash),
    ),
  );
  const attestationObject = isoCBOR.encode(
    new Map<string, string | Uint8Array | Map<string, number | Uint8Array | Uint8Array[]>>([
      ['fmt', 'packed'],
      [
        'attStmt',
        new Map<string, number | Uint8Array | Uint8Array[]>([
          ['alg', -7],
          ['sig', derEcdsaSignature(signature)],
          ['x5c', input.certificateChain.map(der)],
        ]),
      ],
      ['authData', authData],
    ]),
  );
  const id = Buffer.from(credentialId).toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(clientDataJSON).toString('base64url'),
      attestationObject: Buffer.from(attestationObject).toString('base64url'),
      transports: ['usb'],
    },
  };
}
