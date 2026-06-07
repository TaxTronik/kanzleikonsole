// =============================================================================
// Kryptografische RFC-3161-Verifikation (Review A3 — Krypto-Stufe).
//
// Prüft eine archivierte TimeStampResp VOLL kryptografisch:
//   1. PKIStatus granted/grantedWithMods.
//   2. messageImprint == sha256(payload) — bindet das Token an UNSERE Daten
//      (verhindert das Unterschieben einer fremden „granted"-Antwort).
//   3. CMS-Signatur des TimeStampToken (signer 0).
//   4. Cert-Kette bis zu einem VERTRAUTEN Root (out-of-band hinterlegt, NICHT aus
//      der Response) — validiert AS-OF genTime: das TSA-Cert muss zur Stempelzeit
//      gültig gewesen sein (semantisch korrekt UND stabil, wenn es später abläuft).
//   5. EKU id-kp-timeStamping auf dem Signer-Cert.
// Liefert genTime (echte TSA-Zeit) + Seriennummer zurück.
//
// Granular (signatureValid vs. chainTrusted), damit der Aufrufer einen TSA OHNE
// hinterlegten Trust-Anchor NICHT als Manipulation fehldeutet (kein Regress).
//
// Revocation (OCSP/CRL) wird hier NICHT geprüft — der Cert-Status zur Stempelzeit
// ist über eine zeitnahe Erstprüfung + die Hash-Kette abgesichert; volle
// Revocation-Historie ist ein späterer Schritt (dokumentiert).
// =============================================================================

import { webcrypto, createHash, timingSafeEqual } from 'node:crypto';
import * as asn1js from 'asn1js';
import { TimeStampResp, SignedData, TSTInfo, Certificate, CryptoEngine, setEngine } from 'pkijs';

// pkijs braucht eine WebCrypto-Engine; Node (>=18) bringt sie eingebaut mit.
// Der Cast überbrückt einen Typ-Versatz (CryptoEngine vs. ICryptoEngine mit neueren
// ML-KEM-Methoden) — zur Laufzeit korrekt.
setEngine(
  'node-evidence',
  new CryptoEngine({ name: 'node-evidence', crypto: webcrypto as unknown as Crypto }) as unknown as Parameters<typeof setEngine>[1],
);

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const EKU_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const EXT_EKU_OID = '2.5.29.37';

export interface TsVerifyResult {
  /** voller kryptografischer Beweis: Signatur + Kette → Trust-Anchor + EKU. */
  valid: boolean;
  /** CMS-Signatur gültig + messageImprint an payload gebunden. */
  signatureValid: boolean;
  /** Cert-Kette validiert bis zu einem hinterlegten Trust-Anchor (as-of genTime). */
  chainTrusted: boolean;
  reason?: string;
  genTime?: Date;
  serialHex?: string;
}

/** Schneidet die exakten Bytes als sauberen ArrayBuffer heraus (für asn1js). */
function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pemToCertificate(pem: string): Certificate {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(Buffer.from(b64, 'base64'));
  return new Certificate({ schema: asn1js.fromBER(ab(der)).result });
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function hasTimestampingEku(cert: Certificate): boolean {
  const ext = (cert.extensions ?? []).find((e) => e.extnID === EXT_EKU_OID);
  const purposes = (ext?.parsedValue as { keyPurposes?: string[] } | undefined)?.keyPurposes;
  return Array.isArray(purposes) && purposes.includes(EKU_TIMESTAMPING);
}

interface ParsedToken {
  signedData: SignedData;
  tstInfo: TSTInfo;
  genTime: Date;
  serialHex: string;
}

/** TimeStampResp → SignedData + TSTInfo (+ genTime/serial). Wirft bei Strukturfehler. */
function parseTimestampToken(responseBytes: Uint8Array): ParsedToken {
  const ber = asn1js.fromBER(ab(responseBytes));
  if (ber.offset === -1) throw new Error('TimeStampResp: ASN.1-Parsing fehlgeschlagen');
  const tsResp = new TimeStampResp({ schema: ber.result });
  const status = tsResp.status.status;
  if (status !== 0 && status !== 1) throw new Error(`PKIStatus ${status} (nicht granted)`);
  if (!tsResp.timeStampToken) throw new Error('Kein TimeStampToken in der Response');
  const signedData = new SignedData({ schema: tsResp.timeStampToken.content });
  const eContent = signedData.encapContentInfo.eContent;
  if (!eContent) throw new Error('Kein eContent (TSTInfo)');
  const tstInfo = new TSTInfo({ schema: asn1js.fromBER(ab(eContent.valueBlock.valueHexView)).result });
  return {
    signedData,
    tstInfo,
    genTime: tstInfo.genTime,
    serialHex: Buffer.from(tstInfo.serialNumber.valueBlock.valueHexView).toString('hex'),
  };
}

/** Nur die TSA-Metadaten (echte genTime + Seriennummer) — für timestamp(). */
export function extractTsaMeta(responseBytes: Uint8Array): { genTime: Date; serialHex: string } | null {
  try {
    const t = parseTimestampToken(responseBytes);
    return { genTime: t.genTime, serialHex: t.serialHex };
  } catch {
    return null;
  }
}

export async function verifyTimestampResponse(
  payload: Uint8Array,
  responseBytes: Uint8Array,
  trustedRootsPem: readonly string[],
): Promise<TsVerifyResult> {
  let token: ParsedToken;
  try {
    token = parseTimestampToken(responseBytes);
  } catch (e) {
    return { valid: false, signatureValid: false, chainTrusted: false, reason: (e as Error).message };
  }
  const { signedData, tstInfo, genTime, serialHex } = token;

  // 2. messageImprint == sha256(payload) (explizit; pkijs prüft es zusätzlich).
  if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== SHA256_OID) {
    return { valid: false, signatureValid: false, chainTrusted: false, reason: 'messageImprint-Hash ist nicht SHA-256', genTime, serialHex };
  }
  const expected = Uint8Array.from(createHash('sha256').update(payload).digest());
  if (!eqBytes(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView, expected)) {
    return { valid: false, signatureValid: false, chainTrusted: false, reason: 'messageImprint bindet nicht an payload (Token gehört zu anderen Daten)', genTime, serialHex };
  }

  // 3. CMS-Signatur (checkChain:false isoliert die Signatur von der Vertrauenskette).
  //    pkijs erkennt eContentType=TSTInfo und prüft selbst messageImprint==hash(data),
  //    data = die ORIGINALDATEN (payload).
  let signatureValid: boolean;
  let signerCert: Certificate | undefined;
  try {
    const sig = await signedData.verify({ signer: 0, data: ab(payload), extendedMode: true });
    signatureValid = sig.signatureVerified === true;
    signerCert = sig.signerCertificate ?? undefined;
  } catch (e) {
    return { valid: false, signatureValid: false, chainTrusted: false, reason: 'Signatur-/TSTInfo-Verifikation fehlgeschlagen: ' + (e as Error).message, genTime, serialHex };
  }
  if (!signatureValid) {
    return { valid: false, signatureValid: false, chainTrusted: false, reason: 'CMS-Signatur ungültig oder messageImprint bindet nicht', genTime, serialHex };
  }

  // 4. Cert-Kette bis zu einem VERTRAUTEN Root, AS-OF genTime.
  let chainTrusted = false;
  const certs = trustedRootsPem.map(pemToCertificate);
  if (certs.length > 0) {
    try {
      const chain = await signedData.verify({ signer: 0, data: ab(payload), trustedCerts: certs, checkChain: true, checkDate: genTime, extendedMode: true });
      chainTrusted = chain.signatureVerified === true;
      signerCert = chain.signerCertificate ?? signerCert;
    } catch {
      chainTrusted = false;
    }
  }

  // 5. EKU id-kp-timeStamping auf dem Signer-Cert.
  const ekuOk = !!signerCert && hasTimestampingEku(signerCert);

  const valid = signatureValid && chainTrusted && ekuOk;
  const reason = valid
    ? undefined
    : !chainTrusted
      ? 'Kette nicht zu einem hinterlegten Trust-Anchor'
      : !ekuOk
        ? 'Signer-Cert ohne EKU timeStamping'
        : undefined;
  return { valid, signatureValid, chainTrusted, reason, genTime, serialHex };
}
