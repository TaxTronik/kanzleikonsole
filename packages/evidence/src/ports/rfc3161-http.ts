// =============================================================================
// RFC-3161-HTTP-Adapter — echte Anbindung an eine TSA über HTTP.
//
// Codiert eine TimeStampReq mit SHA-256-Hash, sendet sie mit Content-Type
// `application/timestamp-query` zur TSA und speichert die rohe TimeStampResp.
//
// MVP-Verifikation: prüft nur PKIStatus == 0 (granted) am Anfang der Response.
// Eine vollständige kryptografische Verifikation (CMS-SignedData / TSTInfo /
// Zertifikatskette) wird in einer späteren Iteration ergänzt; die Roh-Response
// wird unverändert in `audit_seal.tsa_response_blob` archiviert und ist damit
// jederzeit auch extern (z. B. mit OpenSSL `ts -verify`) prüfbar.
//
// ASN.1-DER-Encoding der TimeStampReq:
//   TimeStampReq ::= SEQUENCE {
//     version       INTEGER { v1(1) },
//     messageImprint MessageImprint,
//     certReq       BOOLEAN DEFAULT FALSE
//   }
//   MessageImprint ::= SEQUENCE {
//     hashAlgorithm AlgorithmIdentifier,   -- SHA-256: OID 2.16.840.1.101.3.4.2.1
//     hashedMessage OCTET STRING
//   }
// =============================================================================

import { createHash } from 'node:crypto';
import { safeFetch } from '@taxtronik/http-utils';
import type { TimestampPort, TimestampResult } from './timestamp';
import { verifyTimestampResponse, extractTsaMeta } from './rfc3161-verify';
import { DEFAULT_TSA_TRUSTED_ROOTS } from './globalsign-roots';
import { resolveTsaTrustedRoots } from './resolve-roots';

// OID 2.16.840.1.101.3.4.2.1 (SHA-256) in DER
const SHA256_OID_DER = new Uint8Array([
  0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
]);
// NULL-Parameter
const ASN1_NULL = new Uint8Array([0x05, 0x00]);

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x100) return new Uint8Array([0x81, n]);
  if (n < 0x10000) return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
  throw new Error('TSR: Länge zu groß');
}

function derSequence(content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = 0x30;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeTimeStampReq(sha256Hash: Uint8Array): Uint8Array {
  // AlgorithmIdentifier ::= SEQ { OID, NULL }
  const algId = derSequence(concat(SHA256_OID_DER, ASN1_NULL));
  // hashedMessage as OCTET STRING
  const hashOctet = concat(
    new Uint8Array([0x04]),
    derLength(sha256Hash.length),
    sha256Hash,
  );
  // MessageImprint ::= SEQ { algId, hashedMessage }
  const messageImprint = derSequence(concat(algId, hashOctet));
  // version INTEGER (1)
  const versionInt = new Uint8Array([0x02, 0x01, 0x01]);
  // certReq BOOLEAN TRUE — Server liefert TSA-Cert mit Response
  const certReq = new Uint8Array([0x01, 0x01, 0xff]);
  return derSequence(concat(versionInt, messageImprint, certReq));
}

/**
 * Liest die PKIStatus-Zahl aus dem Anfang einer TimeStampResp.
 * 0 = granted, 1 = grantedWithMods, 2 = rejection, 3 = waiting, …
 * Gibt `-1` zurück, wenn der Header nicht geparst werden kann.
 */
function parsePkiStatus(tsp: Uint8Array): number {
  // TimeStampResp ::= SEQ { PKIStatusInfo, TimeStampToken OPT }
  // PKIStatusInfo ::= SEQ { status INTEGER, … }
  // Wir suchen die ersten zwei SEQUENCE-Tags und lesen das INTEGER danach.
  if (tsp.length < 6 || tsp[0] !== 0x30) return -1;
  // Skip outer SEQ-Header
  let pos = 1;
  const outerLen = tsp[pos]!;
  if (outerLen & 0x80) {
    const n = outerLen & 0x7f;
    pos += 1 + n;
  } else {
    pos += 1;
  }
  // PKIStatusInfo
  if (tsp[pos] !== 0x30) return -1;
  pos += 1;
  const innerLen = tsp[pos]!;
  if (innerLen & 0x80) {
    const n = innerLen & 0x7f;
    pos += 1 + n;
  } else {
    pos += 1;
  }
  // INTEGER
  if (tsp[pos] !== 0x02) return -1;
  pos += 1;
  const intLen = tsp[pos]!;
  pos += 1;
  if (intLen === 1) return tsp[pos]!;
  if (intLen === 2) return (tsp[pos]! << 8) | tsp[pos + 1]!;
  return -1;
}

const PKI_STATUS_LABELS: Record<number, string> = {
  0: 'granted',
  1: 'grantedWithMods',
  2: 'rejection',
  3: 'waiting',
  4: 'revocationWarning',
  5: 'revocationNotification',
};

/**
 * Standard-Factory für den TSA-Adapter: verdrahtet die aufgelösten Trust-Roots
 * (Default + optionale Operator-Roots aus `TSA_TRUSTED_ROOTS_FILE`). ALLE
 * App-/Worker-/CLI-Konstruktionsstellen sollten diese Factory nutzen, damit
 * eine hinterlegte Produktiv-TSA-Root überall greift (statt nur GlobalSign R6).
 */
export function createRfc3161Adapter(tsaUrl: string, timeoutMs?: number): Rfc3161HttpAdapter {
  return new Rfc3161HttpAdapter(tsaUrl, timeoutMs, resolveTsaTrustedRoots());
}

export class Rfc3161HttpAdapter implements TimestampPort {
  readonly mode = 'rfc3161' as const;

  constructor(
    private readonly tsaUrl: string,
    private readonly timeoutMs = 10_000,
    /** Out-of-band-Trust-Anchors für die Cert-Kette (Default: GlobalSign R6). */
    private readonly trustedRoots: readonly string[] = DEFAULT_TSA_TRUSTED_ROOTS,
  ) {}

  async timestamp(payload: Uint8Array): Promise<TimestampResult> {
    const hash = new Uint8Array(createHash('sha256').update(payload).digest());
    const tsr = encodeTimeStampReq(hash);

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      // SSRF/DNS-Rebinding: NICHT rohes fetch — safeFetch löst die TSA-URL
      // einmal auf, prüft jede IP und pinnt die Connection auf die geprüfte
      // Adresse (undici-Agent). Damit kein zweites, ungeprüftes DNS-Lookup
      // beim eigentlichen Request (TOCTOU gegen interne Dienste, § 203).
      // safeFetch reicht binären Body durch; `signal` überschreibt den
      // safeFetch-Default-Timeout mit unserem TSA-Timeout.
      res = await safeFetch(this.tsaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/timestamp-query',
          Accept: 'application/timestamp-reply',
        },
        body: tsr.buffer.slice(tsr.byteOffset, tsr.byteOffset + tsr.byteLength) as ArrayBuffer,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) {
      throw new Error(`TSA HTTP ${res.status} ${res.statusText} @ ${this.tsaUrl}`);
    }
    const tsp = new Uint8Array(await res.arrayBuffer());
    const status = parsePkiStatus(tsp);
    if (status !== 0 && status !== 1) {
      const label = PKI_STATUS_LABELS[status] ?? String(status);
      throw new Error(`TSA PKIStatus ${status} (${label}) @ ${this.tsaUrl}`);
    }
    // A3: echte TSA-Zeit (genTime) + Seriennummer aus dem TSTInfo lesen; Fallback
    // auf die App-Uhr nur, falls das Token (unerwartet) nicht parsebar ist.
    const meta = extractTsaMeta(tsp);
    return {
      timestampedAt: (meta?.genTime ?? new Date()).toISOString(),
      tsaRequestBlob: tsr,
      tsaResponseBlob: tsp,
      tsaSerial: meta?.serialHex ?? null,
    };
  }

  async verify(payload: Uint8Array, response: Uint8Array | null): Promise<boolean> {
    if (!response) return false;
    // Kryptografische Verifikation (Review A3): messageImprint == sha256(payload),
    // CMS-Signatur, Cert-Kette bis zum hinterlegten Trust-Anchor (Default: GlobalSign
    // R6) AS-OF genTime, EKU timeStamping. Das rohe Blob bleibt zusätzlich extern
    // prüfbar (openssl ts -verify). Revocation (OCSP/CRL) ist noch nicht abgedeckt.
    const r = await verifyTimestampResponse(payload, response, this.trustedRoots);
    if (r.valid) return true; // voller kryptografischer Beweis (inkl. Trust-Anchor)
    // KEIN Regress, aber NICHT lax: cryptoOk verlangt Signatur + messageImprint-
    // Bindung + kritische EKU + ESS — relaxiert NUR die Trust-Anchor-Verankerung
    // (z. B. ein anderer TSA-Anbieter, dessen Root nicht hinterlegt ist). Ein
    // manipuliertes/fremdes Blob, eine kaputte EKU oder fehlende ESS-Bindung
    // scheitern bereits hier (anders als beim früheren reinen signatureValid).
    return r.cryptoOk;
  }

  async verifyDetailed(
    payload: Uint8Array,
    response: Uint8Array | null,
  ): Promise<{ ok: boolean; trustAnchored: boolean }> {
    if (!response) return { ok: false, trustAnchored: false };
    const r = await verifyTimestampResponse(payload, response, this.trustedRoots);
    // ok = wie verify(): voll gültig ODER cryptoOk (No-Regress). trustAnchored =
    // Kette bis zum hinterlegten Root validiert (r.valid impliziert cryptoOk).
    return { ok: r.valid || r.cryptoOk, trustAnchored: r.valid };
  }
}
