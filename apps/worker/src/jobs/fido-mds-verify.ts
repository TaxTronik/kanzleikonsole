// =============================================================================
// FIDO-MDS-BLOB laden und prüfen (P-23)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Unverändert aus apps/web/src/server/auth/webauthn.ts übernommen: Abruf von
// https://mds.fidoalliance.org/ mit 20-MiB-Streaminggrenze, Bindung des
// geschützten JWT-Headers an die freigegebene Signer-/Intermediate-Identität,
// danach Signatur-, Zertifikatsketten- und CRL-Prüfung durch die exakt
// gepinnte, gepatchte SimpleWebAuthn-Version (fail-closed) sowie Prüfung von
// fortlaufender Serie und nextUpdate. Das 30-Sekunden-Zeitlimit umfasst Abruf
// und gesamte Prüfung; das Abbruchsignal reicht bis zu den CRL-Abrufen.
// =============================================================================

import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from '@peculiar/x509';
import type { MetadataBLOBPayloadEntry } from '@simplewebauthn/server';
import { verifyMDSBlob } from '@simplewebauthn/server/helpers';

export const FIDO_MDS_URL = 'https://mds.fidoalliance.org/';
const FIDO_MDS_SIGNER_HOSTNAME = 'mds.fidoalliance.org';
const FIDO_MDS_SIGNER_ORGANIZATION = 'Fido Alliance, Inc.';
const FIDO_MDS_SIGNER_INTERMEDIATE_CN = 'GlobalSign GCC R46 EV TLS CA 2025';
const FIDO_MDS_SIGNER_INTERMEDIATE_ORGANIZATION = 'GlobalSign nv-sa';
const FIDO_MDS_MAX_BLOB_BYTES = 20 * 1024 * 1024;
const FIDO_MDS_MAX_HEADER_CHARS = 512 * 1024;
const FIDO_MDS_MAX_CERTIFICATE_CHARS = 64 * 1024;
export const FIDO_MDS_TIMEOUT_MS = 30_000;

/** Kryptografisch geprüfter MDS-Stand, bereit zur Ablage. */
export type VerifiedFidoMetadata = {
  /** Unveränderter, geprüfter BLOB (für die Prüfsumme der Ablage). */
  blob: string;
  serial: number;
  nextUpdate: Date;
  /** Alle geprüften FIDO2-Einträge (mit AAGUID); gefiltert wird erst in der App. */
  entries: Array<MetadataBLOBPayloadEntry & { aaguid: string }>;
};

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

/**
 * Lädt und verifiziert den vollständigen signierten FIDO-MDS-BLOB selbst. Das
 * ist erforderlich, weil SimpleWebAuthn getStatement() nur das Statement,
 * nicht aber dessen übergeordneten Zertifizierungs-/Sperrstatus zurückgibt.
 * Die Auswertung gegen die lokale Allowlist folgt erst in der App, nachdem die
 * Serie verankert ist.
 */
async function downloadVerifiedFidoMetadataBeforeDeadline(
  signal: AbortSignal,
): Promise<VerifiedFidoMetadata> {
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
  signal.throwIfAborted();
  return {
    blob,
    serial: verified.payload.no,
    nextUpdate: verified.parsedNextUpdate,
    entries: verified.payload.entries.filter(
      (entry): entry is MetadataBLOBPayloadEntry & { aaguid: string } => !!entry.aaguid,
    ),
  };
}

export async function downloadVerifiedFidoMetadata(): Promise<VerifiedFidoMetadata> {
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
      downloadVerifiedFidoMetadataBeforeDeadline(controller.signal),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
