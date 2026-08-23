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
// Granular (signatureValid vs. chainTrusted) für eine präzise Diagnose. Nur
// `valid` ist ein erfolgreicher Nachweis; `cryptoOk` authentisiert den TSA-
// Betreiber ohne Trust-Anchor ausdrücklich nicht.
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
  new CryptoEngine({
    name: 'node-evidence',
    crypto: webcrypto,
  } as unknown as ConstructorParameters<typeof CryptoEngine>[0]) as unknown as Parameters<
    typeof setEngine
  >[1],
);

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const SHA1_OID = '1.3.14.3.2.26';
const EKU_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const EXT_EKU_OID = '2.5.29.37';
// ESS (RFC 5035 / 2634): bindet die Signatur an EIN bestimmtes Signer-Cert (per Hash).
const ID_AA_SIGNING_CERT = '1.2.840.113549.1.9.16.2.12'; // SigningCertificate (SHA-1)
const ID_AA_SIGNING_CERT_V2 = '1.2.840.113549.1.9.16.2.47'; // SigningCertificateV2

export interface TsVerifyResult {
  /** voller kryptografischer Beweis: Signatur + Kette → Trust-Anchor + EKU. */
  valid: boolean;
  /** CMS-Signatur gültig + messageImprint an payload gebunden. */
  signatureValid: boolean;
  /** Cert-Kette validiert bis zu einem hinterlegten Trust-Anchor (as-of genTime). */
  chainTrusted: boolean;
  /**
   * Alles AUSSER der Trust-Anchor-Verankerung: Signatur + messageImprint-Bindung
   * + kritische EKU + ESS. true bei einem voll wohlgeformten, an unsere Daten
   * gebundenen TSA-Token, dessen Root nur (noch) nicht hinterlegt ist. Dieses
   * Feld dient ausschließlich der Fehlerdiagnose und ist kein Erfolgsstatus.
   */
  cryptoOk: boolean;
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

/**
 * Inhalt einer OCTET STRING — robust gegen die KONSTRUIERTE (chunked) Kodierung.
 * CMS-eContent darf primitiv ODER konstruiert sein (RFC 5652 / BER): GlobalSign
 * liefert primitiv, pkijs/andere Stacks chunked. Beide tragen dieselben Bytes;
 * der Verifier darf an dieser Variante nicht scheitern (sonst false-negative).
 */
function octetStringBytes(os: asn1js.OctetString): Uint8Array {
  const anyOs = os as unknown as {
    idBlock?: { isConstructed?: boolean };
    valueBlock: {
      value?: Array<{ valueBlock: { valueHexView: Uint8Array } }>;
      valueHexView: Uint8Array;
    };
  };
  const vb = anyOs.valueBlock;
  // NUR bei konstruierter Kodierung die Kindblöcke zusammenfügen. Die Unterscheidung
  // MUSS über idBlock.isConstructed laufen — asn1js befüllt `value` auch bei
  // primitiven OCTET STRINGs, sodass eine Längen-Prüfung allein primitiv für
  // konstruiert hielte und falsche Bytes läse.
  if (anyOs.idBlock?.isConstructed && Array.isArray(vb.value) && vb.value.length > 0) {
    const parts = vb.value.map((c) => new Uint8Array(c.valueBlock.valueHexView));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  return new Uint8Array(vb.valueHexView);
}

/**
 * ESS-Bindung (RFC 3161 §2.4.1 + RFC 5035): das Token MUSS ein signiertes
 * SigningCertificate(V2)-Attribut tragen, dessen certHash auf den TATSÄCHLICHEN
 * Signer-Cert passt. Ohne das könnte ein Angreifer ein anderes (kollidierendes)
 * Cert in die SignedData-Zertifikatsmenge schmuggeln. OpenSSL `ts -verify`
 * erzwingt das ebenfalls — wir bleiben so streng wie die unabhängige Referenz.
 */
function checkEssSigningCert(
  signedData: SignedData,
  signerCert: Certificate,
): { ok: boolean; reason?: string } {
  const attrs = (signedData.signerInfos?.[0]?.signedAttrs?.attributes ?? []) as Array<{
    type: string;
    values: unknown[];
  }>;
  const v2 = attrs.find((a) => a.type === ID_AA_SIGNING_CERT_V2);
  const v1 = attrs.find((a) => a.type === ID_AA_SIGNING_CERT);
  const attr = v2 ?? v1;
  if (!attr)
    return { ok: false, reason: 'Kein ESS signingCertificate(V2)-Attribut (RFC 3161 §2.4.1)' };
  const isV2 = attr === v2;
  // SigningCertificate[V2] ::= SEQ { certs SEQ OF ESSCertID[V2], policies OPTIONAL }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const essCert: any = (attr.values?.[0] as any)?.valueBlock?.value?.[0]?.valueBlock?.value?.[0];
  if (!essCert) return { ok: false, reason: 'ESS-Attribut ohne ESSCertID' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields = (essCert.valueBlock?.value ?? []) as any[];
  let hashOid = isV2 ? SHA256_OID : SHA1_OID; // V2-Default sha256, V1 = sha1
  let certHashBlock = fields[0];
  if (isV2 && fields[0]?.idBlock?.tagNumber === 16) {
    // ESSCertIDv2 mit explizitem hashAlgorithm (AlgorithmIdentifier SEQUENCE).
    hashOid = fields[0].valueBlock?.value?.[0]?.valueBlock?.toString?.() ?? hashOid;
    certHashBlock = fields[1];
  }
  const essHash: Uint8Array | undefined = certHashBlock?.valueBlock?.valueHexView;
  if (!essHash || essHash.length === 0) return { ok: false, reason: 'ESS-Attribut ohne certHash' };
  const algo = hashOid === SHA1_OID ? 'sha1' : 'sha256';
  const certDer = Buffer.from(signerCert.toSchema().toBER(false));
  const computed = Uint8Array.from(createHash(algo).update(certDer).digest());
  if (!eqBytes(new Uint8Array(essHash), computed)) {
    return {
      ok: false,
      reason: 'ESS certHash bindet nicht an den Signer-Cert (Cert-Substitution?)',
    };
  }
  return { ok: true };
}

export function hasTimestampingEku(cert: Certificate): boolean {
  const ext = (cert.extensions ?? []).find((e) => e.extnID === EXT_EKU_OID);
  // RFC 3161 §2.1(10)/§2.3: Der Schlüssel ist ausschliesslich fuer Timestamps
  // reserviert; das Zertifikat muss genau diesen kritischen EKU-Zweck tragen.
  // `timeStamping` nur zusaetzlich zu codeSigning/serverAuth zu erlauben wuerde
  // ein Mehrzweckzertifikat entgegen dieser Zweckbindung als TSA akzeptieren.
  if (!ext || !ext.critical) return false;
  const purposes = (ext.parsedValue as { keyPurposes?: string[] } | undefined)?.keyPurposes;
  return Array.isArray(purposes) && purposes.length === 1 && purposes[0] === EKU_TIMESTAMPING;
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
  const eBytes = octetStringBytes(eContent);
  const eBer = asn1js.fromBER(ab(eBytes));
  if (eBer.offset === -1) throw new Error('TSTInfo: ASN.1-Parsing fehlgeschlagen');
  const tstInfo = new TSTInfo({ schema: eBer.result });
  return {
    signedData,
    tstInfo,
    genTime: tstInfo.genTime,
    serialHex: Buffer.from(tstInfo.serialNumber.valueBlock.valueHexView).toString('hex'),
  };
}

/** Nur die TSA-Metadaten (echte genTime + Seriennummer) — für timestamp(). */
export function extractTsaMeta(
  responseBytes: Uint8Array,
): { genTime: Date; serialHex: string } | null {
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
    return {
      valid: false,
      signatureValid: false,
      chainTrusted: false,
      cryptoOk: false,
      reason: (e as Error).message,
    };
  }
  const { signedData, tstInfo, genTime, serialHex } = token;

  // 2. messageImprint == sha256(payload) (explizit; pkijs prüft es zusätzlich).
  if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== SHA256_OID) {
    return {
      valid: false,
      signatureValid: false,
      chainTrusted: false,
      cryptoOk: false,
      reason: 'messageImprint-Hash ist nicht SHA-256',
      genTime,
      serialHex,
    };
  }
  const expected = Uint8Array.from(createHash('sha256').update(payload).digest());
  if (!eqBytes(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView, expected)) {
    return {
      valid: false,
      signatureValid: false,
      chainTrusted: false,
      cryptoOk: false,
      reason: 'messageImprint bindet nicht an payload (Token gehört zu anderen Daten)',
      genTime,
      serialHex,
    };
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
    return {
      valid: false,
      signatureValid: false,
      chainTrusted: false,
      cryptoOk: false,
      reason: 'Signatur-/TSTInfo-Verifikation fehlgeschlagen: ' + (e as Error).message,
      genTime,
      serialHex,
    };
  }
  if (!signatureValid) {
    return {
      valid: false,
      signatureValid: false,
      chainTrusted: false,
      cryptoOk: false,
      reason: 'CMS-Signatur ungültig oder messageImprint bindet nicht',
      genTime,
      serialHex,
    };
  }

  // 4. Cert-Kette bis zu einem VERTRAUTEN Root, AS-OF genTime.
  let chainTrusted = false;
  const certs = trustedRootsPem.map(pemToCertificate);
  if (certs.length > 0) {
    try {
      const chain = await signedData.verify({
        signer: 0,
        data: ab(payload),
        trustedCerts: certs,
        checkChain: true,
        checkDate: genTime,
        extendedMode: true,
      });
      chainTrusted = chain.signatureVerified === true;
      signerCert = chain.signerCertificate ?? signerCert;
    } catch {
      chainTrusted = false;
    }
  }

  // 5. EKU id-kp-timeStamping (kritisch) auf dem Signer-Cert.
  const ekuOk = !!signerCert && hasTimestampingEku(signerCert);

  // 6. ESS-Bindung: signiertes SigningCertificate(V2) muss auf den Signer-Cert passen.
  const ess = signerCert
    ? checkEssSigningCert(signedData, signerCert)
    : { ok: false, reason: 'kein Signer-Cert für ESS-Bindung' };

  // cryptoOk = alles außer Trust-Anchor (Signatur + Imprint + EKU + ESS).
  const cryptoOk = signatureValid && ekuOk && ess.ok;
  const valid = cryptoOk && chainTrusted;
  const reason = valid
    ? undefined
    : !ekuOk
      ? 'Signer-Cert ohne ausschliessliche kritische EKU id-kp-timeStamping (RFC 3161 §2.3)'
      : !ess.ok
        ? ess.reason
        : !chainTrusted
          ? 'Kette nicht zu einem hinterlegten Trust-Anchor'
          : undefined;
  return { valid, signatureValid, chainTrusted, cryptoOk, reason, genTime, serialHex };
}
