// =============================================================================
// Gehärtete X.509-Pfadprüfung mit Sperrlisten (T-02)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Gemeinsamer Kern für Web (Attestationskette der Hardware-Registrierung) und
// Worker (Signaturkette des FIDO-MDS-BLOBs). Übernimmt die Semantik des
// versionsgebundenen Patches auf @simplewebauthn/server 13.3.3
// (isCertRevoked, validateCertificatePath) als eigenen Repository-Code.
//
//   - Höchstens 5 Kettenzertifikate und 64 Trust Anchors. Ohne Trust Anchor
//     wird abgewiesen (SimpleWebAuthn übersprang die Prüfung in diesem Fall).
//   - Jedes Zertifikat muss zeitlich gültig sein; kritisch dürfen nur
//     KeyUsage und BasicConstraints sein, Name-/Policy-Constraints und
//     inhibitAnyPolicy werden nicht ausgewertet und daher abgewiesen.
//   - Die Kette wird ohne Netzzugriff bis zu genau einer Trust Anchor gebaut;
//     jede ausstellende CA braucht kritische CA-BasicConstraints, keyCertSign
//     und eine eingehaltene Pfadlänge.
//   - Erst danach prüft isCertRevoked jedes Nicht-Wurzel-Zertifikat gegen die
//     CRL seines tatsächlichen Issuers in dieser Kette: nur http/https auf
//     Port 80/443, ohne Zugangsdaten und Redirects, mit dem Abbruchsignal des
//     Aufrufers und höchstens 5 MiB. Abruf-, HTTP-, Parse- und Prüffehler
//     sperren (fail-closed). Die CRL muss frisch, vom Issuer signiert und
//     ungeteilt sein: genau ein Distribution Point mit genau einer URI, keine
//     Delta-/IDP-/Freshest-CRL und keine unbekannten kritischen Extensions.
//   - Der Sperrstatus wird je Issuer-Fingerprint, Seriennummer und CRL-URL
//     höchstens bis zum signierten nextUpdate gecacht (max. 256 Einträge).
//
// Fehlermeldungen entsprechen wörtlich dem früheren Patch (Logs, Tests).
// Auf Modulebene werden bewusst keine @peculiar/x509-Exporte ausgewertet.
// =============================================================================

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  CRLDistributionPointsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509ChainBuilder,
  X509Crl,
  type Extension,
} from '@peculiar/x509';

const MAX_PATH_CERTIFICATES = 5;
const MAX_TRUST_ANCHORS = 64;
const MAX_CACHE_ENTRIES = 256;
const MAX_CRL_BYTES = 5 * 1024 * 1024;
const DELTA_CRL_INDICATOR_OID = '2.5.29.27';
const ISSUING_DISTRIBUTION_POINT_OID = '2.5.29.28';
const FRESHEST_CRL_OID = '2.5.29.46';
/** KeyUsage, BasicConstraints. */
const SUPPORTED_CRITICAL_EXTENSION_OIDS = new Set(['2.5.29.15', '2.5.29.19']);
/** NameConstraints, PolicyConstraints, inhibitAnyPolicy. */
const UNSUPPORTED_PATH_CONSTRAINT_OIDS = new Set(['2.5.29.30', '2.5.29.36', '2.5.29.54']);

export type RevocationCheckOptions = {
  /** Abbruchsignal des Gesamtzeitlimits; wird an den CRL-Abruf weitergereicht. */
  signal?: AbortSignal;
  /** Tatsächlicher Issuer aus einer zuvor aufgebauten, vertrauenswürdigen Kette. */
  issuer?: X509Certificate;
};

export type CertificatePathOptions = {
  /** Abbruchsignal des Gesamtzeitlimits; wird an jeden CRL-Abruf weitergereicht. */
  signal?: AbortSignal;
};

type DistributionPoint = CRLDistributionPointsExtension['distributionPoints'][number];

const revocationStatusCache = new Map<string, { revoked: boolean; nextUpdate: Date }>();

/** Name `InvalidX5CChain` wie in SimpleWebAuthn, damit Logs und Tests stabil bleiben. */
export class InvalidCertificatePathError extends Error {
  constructor(message = 'x5c could not be chained to any specified trust anchor', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InvalidX5CChain';
  }
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function revocationCacheKey(
  cert: X509Certificate,
  issuer: X509Certificate,
  crlURL: string,
): Promise<string> {
  const issuerThumbprint = await issuer.getThumbprint('SHA-256');
  return `${toHex(issuerThumbprint)}:${cert.serialNumber}:${crlURL}`;
}

function rememberRevocationStatus(key: string, revoked: boolean, nextUpdate: Date): void {
  revocationStatusCache.delete(key);
  revocationStatusCache.set(key, { revoked, nextUpdate });
  while (revocationStatusCache.size > MAX_CACHE_ENTRIES) {
    const oldest = revocationStatusCache.keys().next().value;
    if (oldest === undefined) break;
    revocationStatusCache.delete(oldest);
  }
}

function parseCRLURL(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('Certificate revocation list URL is invalid', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.port && !['80', '443'].includes(parsed.port))
  ) {
    throw new Error('Certificate revocation list URL is not permitted');
  }
  return parsed.toString();
}

function unsupportedDistribution(): Error {
  return new Error('Certificate revocation list distribution is unsupported');
}

/** Genau eine vollständige URI ohne Reason-/Issuer-Scope oder relativen Namen. */
function singleFullNameURI(point: DistributionPoint): string {
  const pointName = point.distributionPoint;
  const fullName = pointName?.fullName;
  const uri = fullName?.[0]?.uniformResourceIdentifier;
  if (
    !pointName ||
    pointName.nameRelativeToCRLIssuer !== undefined ||
    point.reasons !== undefined ||
    point.cRLIssuer !== undefined ||
    !fullName ||
    fullName.length !== 1 ||
    typeof uri !== 'string' ||
    !uri
  ) {
    throw unsupportedDistribution();
  }
  return uri;
}

function extractCRLURL(cert: X509Certificate): string | undefined {
  const certificateExtensions: readonly Extension[] = cert.extensions ?? [];
  if (certificateExtensions.some((extension) => extension.type === FRESHEST_CRL_OID)) {
    throw new Error('Certificate freshest CRL distribution is unsupported');
  }
  const extensions = certificateExtensions.filter(
    (extension): extension is CRLDistributionPointsExtension =>
      extension instanceof CRLDistributionPointsExtension,
  );
  if (extensions.length === 0) {
    return undefined;
  }
  if (extensions.length !== 1) {
    throw unsupportedDistribution();
  }
  const distributionPoints = extensions[0]!.distributionPoints;
  if (distributionPoints.length !== 1) {
    throw unsupportedDistribution();
  }
  return singleFullNameURI(distributionPoints[0]!);
}

function assertSupportedCRLExtensions(data: X509Crl): void {
  for (const extension of data.extensions ?? []) {
    if (
      extension.critical ||
      extension.type === DELTA_CRL_INDICATOR_OID ||
      extension.type === ISSUING_DISTRIBUTION_POINT_OID ||
      extension.type === FRESHEST_CRL_OID
    ) {
      throw new Error('Certificate revocation list contains unsupported extensions');
    }
  }
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function assertCRLAuthenticAndFresh(data: X509Crl, issuer: X509Certificate): Promise<void> {
  const now = new Date();
  assertSupportedCRLExtensions(data);
  if (data.issuer !== issuer.subject) {
    throw new Error('Certificate revocation list issuer does not match certificate issuer');
  }
  const { thisUpdate, nextUpdate } = data;
  if (
    !isValidDate(thisUpdate) ||
    thisUpdate > now ||
    !isValidDate(nextUpdate) ||
    nextUpdate <= now
  ) {
    throw new Error('Certificate revocation list is not currently valid');
  }
  const crlAuthorityKeyID = data.getExtension(AuthorityKeyIdentifierExtension)?.keyId;
  const issuerSubjectKeyID = issuer.getExtension(SubjectKeyIdentifierExtension)?.keyId;
  if (
    crlAuthorityKeyID &&
    issuerSubjectKeyID &&
    crlAuthorityKeyID.toLowerCase() !== issuerSubjectKeyID.toLowerCase()
  ) {
    throw new Error('Certificate revocation list authority key does not match issuer');
  }
  const issuerKeyUsage = issuer.getExtension(KeyUsagesExtension);
  if (issuerKeyUsage && (issuerKeyUsage.usages & KeyUsageFlags.cRLSign) === 0) {
    throw new Error('Certificate issuer is not permitted to sign revocation lists');
  }
  if (!(await data.verify({ publicKey: issuer.publicKey }))) {
    throw new Error('Certificate revocation list signature is invalid');
  }
}

function crlSizeLimitError(): Error {
  return new Error('Certificate revocation list exceeds the size limit');
}

async function readCRLBytes(response: Response): Promise<ArrayBuffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_CRL_BYTES) {
      throw crlSizeLimitError();
    }
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_CRL_BYTES) {
      throw crlSizeLimitError();
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CRL_BYTES) {
        await reader.cancel();
        throw crlSizeLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function downloadCRL(crlURL: string, signal: AbortSignal | undefined): Promise<ArrayBuffer> {
  try {
    // globalThis.fetch zur Aufrufzeit: Tests ersetzen den globalen Abruf.
    const response = await globalThis.fetch(crlURL, { signal, redirect: 'error' });
    if (!response.ok) {
      throw new Error(`CRL endpoint responded with HTTP ${response.status}`);
    }
    return await readCRLBytes(response);
  } catch (error) {
    throw new Error('Certificate revocation list could not be downloaded', { cause: error });
  }
}

/**
 * Prüft, ob die CRL des Issuers das Zertifikat sperrt. Ohne
 * CRL-Distribution-Point gibt es nichts zu prüfen (`false`). Der Issuer muss
 * aus einer bereits aufgebauten, vertrauenswürdigen Kette stammen; jeder
 * Abruf-, Parse- oder Prüffehler wirft (fail-closed).
 *
 * CRL-Struktur nach https://tools.ietf.org/html/rfc5280#page-117
 */
export async function isCertRevoked(
  cert: X509Certificate,
  options: RevocationCheckOptions = {},
): Promise<boolean> {
  const rawCRLURL = extractCRLURL(cert);
  if (!rawCRLURL) {
    return false;
  }
  if (!options.issuer) {
    throw new Error('Certificate issuer is required to verify its revocation list');
  }
  const crlURL = parseCRLURL(rawCRLURL);
  const cacheKey = await revocationCacheKey(cert, options.issuer, crlURL);
  const cached = revocationStatusCache.get(cacheKey);
  if (cached && cached.nextUpdate > new Date()) {
    return cached.revoked;
  }
  revocationStatusCache.delete(cacheKey);
  const certListBytes = await downloadCRL(crlURL, options.signal);
  let data: X509Crl;
  try {
    data = new X509Crl(certListBytes);
  } catch (error) {
    throw new Error('Certificate revocation list could not be parsed', { cause: error });
  }
  try {
    await assertCRLAuthenticAndFresh(data, options.issuer);
  } catch (error) {
    throw new Error('Certificate revocation list could not be verified', { cause: error });
  }
  const revoked = Boolean(data.findRevoked(cert));
  // assertCRLAuthenticAndFresh hat ein gültiges, zukünftiges nextUpdate verlangt.
  rememberRevocationStatus(cacheKey, revoked, data.nextUpdate!);
  return revoked;
}

function assertCertIsWithinValidTimeWindow(certificate: X509Certificate): void {
  const now = new Date(Date.now());
  if (certificate.notBefore > now || certificate.notAfter < now) {
    throw new Error('Certificate is not yet valid or expired');
  }
}

function assertNoUnsupportedCriticalExtensions(certificate: X509Certificate): void {
  for (const extension of certificate.extensions ?? []) {
    if (UNSUPPORTED_PATH_CONSTRAINT_OIDS.has(extension.type)) {
      throw new Error(`Unsupported certificate path constraint ${extension.type}`);
    }
    if (extension.critical && !SUPPORTED_CRITICAL_EXTENSION_OIDS.has(extension.type)) {
      throw new Error(`Unsupported critical certificate extension ${extension.type}`);
    }
  }
}

function assertCertificateAuthorityConstraints(chain: readonly X509Certificate[]): void {
  for (let i = 1; i < chain.length; i++) {
    const certificate = chain[i]!;
    const basicConstraints = certificate.getExtension(BasicConstraintsExtension);
    if (!basicConstraints?.ca || !basicConstraints.critical) {
      throw new Error('Certificate issuer is not an authorized certificate authority');
    }
    const keyUsage = certificate.getExtension(KeyUsagesExtension);
    if (!keyUsage || (keyUsage.usages & KeyUsageFlags.keyCertSign) === 0) {
      throw new Error('Certificate issuer is not permitted to sign certificates');
    }
    const subordinateCACount = i - 1;
    if (
      basicConstraints.pathLength !== undefined &&
      basicConstraints.pathLength < subordinateCACount
    ) {
      throw new Error('Certificate path exceeds a path length constraint');
    }
  }
}

async function assertCertNotRevoked(
  certificate: X509Certificate,
  issuer: X509Certificate,
  options: CertificatePathOptions,
): Promise<void> {
  if (await isCertRevoked(certificate, { ...options, issuer })) {
    throw new Error('Found revoked certificate in certificate path');
  }
}

/** Parst und prüft die (nicht vertrauenswürdigen) Kettenzertifikate ohne Netzzugriff. */
function parsePathCertificates(certificatesPEM: readonly string[]): X509Certificate[] {
  const parsed = certificatesPEM.map((certPEM) => new X509Certificate(certPEM));
  parsed.forEach((certificate, index) => {
    try {
      assertCertIsWithinValidTimeWindow(certificate);
      assertNoUnsupportedCriticalExtensions(certificate);
    } catch (error) {
      throw new Error(`Found invalid certificate in x5c:\n${certificatesPEM[index]}`, {
        cause: error,
      });
    }
  });
  return parsed;
}

/** Zeitlich gültige Trust Anchors ohne nicht unterstützte Extensions. */
function usableTrustAnchors(trustAnchorsPEM: readonly string[]): X509Certificate[] {
  const parsed = trustAnchorsPEM.map((certPEM) => {
    try {
      return new X509Certificate(certPEM);
    } catch (error) {
      throw new Error(`Could not parse trust anchor certificate:\n${certPEM}`, { cause: error });
    }
  });
  const usable = parsed.filter((certificate) => {
    try {
      assertCertIsWithinValidTimeWindow(certificate);
      assertNoUnsupportedCriticalExtensions(certificate);
      return true;
    } catch {
      return false;
    }
  });
  if (usable.length === 0) {
    throw new Error('No specified trust anchor was valid for verifying x5c');
  }
  return usable;
}

/** Baut die Kette bis zu genau dieser Trust Anchor und prüft danach die Sperrlisten. */
async function assertPathToTrustAnchor(
  certificates: readonly X509Certificate[],
  anchor: X509Certificate,
  options: CertificatePathOptions,
): Promise<void> {
  const withTrustAnchor = [...certificates, anchor];
  const numUniqueCerts = new Set(withTrustAnchor.map((cert) => cert.toString('pem'))).size;
  if (numUniqueCerts !== withTrustAnchor.length) {
    throw new Error('Invalid certificate path: found duplicate certificates');
  }
  const [leaf, ...intermediates] = certificates;
  const chainBuilder = new X509ChainBuilder({ certificates: [...intermediates, anchor] });
  // Kette ab Index 0: Blatt -> Intermediates -> Trust Anchor.
  const chain = await chainBuilder.build(leaf!);
  if (
    chain.length !== numUniqueCerts ||
    chain[chain.length - 1]!.toString('pem') !== anchor.toString('pem')
  ) {
    throw new Error('Certificate path did not terminate at the selected trust anchor');
  }
  assertCertificateAuthorityConstraints(chain);
  // Wurzeln gelten out-of-band als vertrauenswürdig. Jedes andere Zertifikat
  // wird erst jetzt gegen eine CRL seines tatsächlichen Issuers geprüft.
  for (let i = 0; i < chain.length - 1; i++) {
    await assertCertNotRevoked(chain[i]!, chain[i + 1]!, options);
  }
}

/**
 * Prüft, dass die PEM-Kette (Blatt zuerst) zu einer der Trust Anchors führt,
 * und erst dann die Sperrlisten aller Nicht-Wurzel-Zertifikate. Wirft
 * `InvalidCertificatePathError` (Name `InvalidX5CChain`), wenn keine Trust
 * Anchor zu einem gültigen, nicht gesperrten Pfad führt.
 */
export async function validateCertificatePath(
  certificatesPEM: readonly string[],
  trustAnchorsPEM: readonly string[],
  options: CertificatePathOptions = {},
): Promise<true> {
  if (trustAnchorsPEM.length === 0) {
    throw new InvalidCertificatePathError('Certificate path has no trust anchor');
  }
  if (
    certificatesPEM.length === 0 ||
    certificatesPEM.length > MAX_PATH_CERTIFICATES ||
    trustAnchorsPEM.length > MAX_TRUST_ANCHORS
  ) {
    throw new InvalidCertificatePathError('Certificate path has an invalid number of certificates');
  }
  const certificates = parsePathCertificates(certificatesPEM);
  const anchors = usableTrustAnchors(trustAnchorsPEM);
  let lastError: unknown;
  // Kette vor jedem Abruf einer zertifikatsgesteuerten CRL-URL aufbauen.
  for (const anchor of anchors) {
    try {
      await assertPathToTrustAnchor(certificates, anchor, options);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw new InvalidCertificatePathError(undefined, lastError);
}
