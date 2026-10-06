// =============================================================================
// Attestationskette der Hardware-Registrierung (T-02)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Bibliotheksunabhängige Prüfung der packed-Attestation; bis T-02 lag sie in
// einem versionsgebundenen Patch auf @simplewebauthn/server 13.3.3.
//   - SimpleWebAuthn erhält die freigegebenen Metadata Statements ohne
//     attestationRootCertificates (libraryAttestationStatement). Die
//     Bibliothek prüft weiterhin Challenge, Origin, RP-ID, Flags,
//     Algorithmen, Zertifikatsfelder und die Attestationssignatur, baut aber
//     keine eigene Kette und lädt keine Sperrliste: Upstream geschähe beides
//     vor dem Kettenaufbau und fail-open.
//   - extractAttestedAaguid verlangt die nichtkritische FIDO-AAGUID-Extension
//     mit exakt 16 Byte; der Aufrufer vergleicht sie vor jedem Netzzugriff
//     mit der signierten Authenticator-AAGUID.
//   - assertTrustedAttestationPath prüft danach die x5c-Kette gegen die
//     Wurzeln des gespeicherten, signaturgeprüften MDS-Statements, gehärtet
//     und fail-closed (@taxtronik/crypto/certificate-path), mit dem
//     Abbruchsignal des Zeitlimits bis in jeden CRL-Abruf. Wie in
//     SimpleWebAuthn entfällt die Kettenprüfung nur, wenn x5c aus genau
//     einem Zertifikat besteht, das selbst als Wurzel im Statement steht.
// =============================================================================

import type { X509Certificate } from '@peculiar/x509';
import type { MetadataStatement, Uint8Array_ } from '@simplewebauthn/server';
import { convertCertBufferToPEM } from '@simplewebauthn/server/helpers';
import { validateCertificatePath } from '@taxtronik/crypto/certificate-path';
import { HardwareAccessVerificationError } from './webauthn-shared';

const FIDO_AAGUID_OID = '1.3.6.1.4.1.45724.1.1.4';

/** Statement-Kopie für den MetadataService von SimpleWebAuthn: ohne Wurzeln. */
export function libraryAttestationStatement(statement: MetadataStatement): MetadataStatement {
  return { ...statement, attestationRootCertificates: [] };
}

export function extractAttestedAaguid(certificate: X509Certificate): string {
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

/**
 * Prüft die x5c-Kette (Blatt zuerst, DER) gegen die Wurzeln des
 * vertrauenswürdigen Statements einschließlich Sperrlisten. Wirft bei jedem
 * Ketten-, Abruf- oder Prüffehler; der Aufrufer weist generisch ab.
 */
export async function assertTrustedAttestationPath(input: {
  certificateChain: readonly Uint8Array_[];
  attestationRootCertificates: readonly string[];
  signal: AbortSignal;
}): Promise<void> {
  // PEM-Umwandlung wie in SimpleWebAuthn, damit der Selbstbezug identisch erkannt wird.
  const chain = input.certificateChain.map((certificate) => convertCertBufferToPEM(certificate));
  const roots = input.attestationRootCertificates.map((root) => convertCertBufferToPEM(root));
  if (chain.length === 1 && roots.includes(chain[0]!)) {
    return;
  }
  await validateCertificatePath(chain, roots, { signal: input.signal });
}
