import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { env } from '@taxtronik/config';
import {
  s3,
  classificationToTier,
  getBucketForTier,
  type ProtectionTier,
} from './client';

/**
 * § 147 AO Aufbewahrungsfristen: „Die Aufbewahrungsfrist beginnt mit dem
 * Schluss des Kalenderjahres, in dem die letzte Eintragung gemacht worden
 * ist, ..."
 *
 * Konkret: Beleg vom 2026-03-15 → Frist beginnt 2026-12-31 → Ende 2036-12-31
 * (10 vollständige Jahre nach Jahresende). Object-Lock-Retain-Until setzen wir
 * etwas großzügiger auf den Folge-Stichtag 2037-01-01, damit auch späte
 * Abruf-/Auskunfts-Anfragen abgedeckt sind.
 *
 * Vorher: hartcodiert `10 * 365.25 * 24 * 60 * 60 * 1000` — landete bei
 * Belegen vom Jahresanfang knapp 9.5 Kalenderjahre nach Erstellung, also
 * potenziell VOR Ende der gesetzlichen Frist.
 */
export function gobdRetentionUntil(now: Date = new Date()): Date {
  // Jahresende des Erstellungsjahres + 10 volle Jahre + 1 Tag-Puffer.
  const startYear = now.getUTCFullYear();
  return new Date(Date.UTC(startYear + 10 + 1, 0, 1, 0, 0, 0, 0));
}

/**
 * B-1: § 8 Abs. 4 GwG schreibt 5 Jahre Aufbewahrung vor — und satz 4 verlangt
 * EXPLIZIT „unverzügliche Vernichtung" nach Ablauf. Längere Aufbewahrung ist
 * nicht zulässig (DSGVO Art. 5 Abs. 1 lit. e + GwG-Höchstfrist).
 *
 * Wir setzen Object-Lock-Retain-Until daher auf 5 Jahre + 1 Tag (Jahresende
 * basierte Berechnung wäre für GwG-Akten weniger relevant — Frist beginnt
 * mit Ende der Geschäftsbeziehung, nicht mit Erstellungsjahr; das ist eine
 * Operations-Sache, nicht Object-Lock-Sache).
 *
 * Object-Lock-Modus je Stufe (Review F2 — siehe lockModeForTier): GwG-Belege werden
 * im Modus GOVERNANCE geschrieben, GOBD in COMPLIANCE. Hintergrund: COMPLIANCE lässt
 * sich vor Ablauf von NIEMANDEM (auch nicht root) verkürzen oder abschalten — damit
 * wäre die von § 8 Abs. 4 Satz 4 GwG geforderte UNVERZÜGLICHE Vernichtung nach Ende
 * der Geschäftsbeziehung technisch nicht erfüllbar (Konflikt mit DSGVO Art. 5 Abs. 1
 * lit. e). GOVERNANCE erlaubt die privilegierte Frühlöschung (s3:BypassGovernance-
 * Retention), GoBD bleibt voll unveränderbar.
 * NOCH OFFEN (Ops): die eigentliche Frühlöschung nach Beziehungsende ist ein
 * Lifecycle-Schritt (Löschen MIT BypassGovernanceRetention); zudem SeaweedFS'
 * Object-Lock-Emulation gegen reales S3-GOVERNANCE-Verhalten prüfen.
 */
export function gwgRetentionUntil(now: Date = new Date()): Date {
  const startYear = now.getUTCFullYear();
  return new Date(Date.UTC(startYear + 5 + 1, 0, 1, 0, 0, 0, 0));
}

function retentionForTier(tier: ProtectionTier): Date | null {
  if (tier === 'GOBD') return gobdRetentionUntil();
  if (tier === 'GWG') return gwgRetentionUntil();
  return null;
}

/**
 * Object-Lock-Modus je Schutzstufe (Review F2):
 *  - GWG  → GOVERNANCE: § 8 Abs. 4 Satz 4 GwG verlangt die UNVERZÜGLICHE
 *    Vernichtung nach Ende der Geschäftsbeziehung. COMPLIANCE würde das technisch
 *    verhindern (vor Ablauf von niemandem löschbar). GOVERNANCE erlaubt die
 *    privilegierte Frühlöschung (s3:BypassGovernanceRetention) — für alle ohne
 *    dieses Recht bleibt die fristgebundene Unveränderbarkeit erhalten.
 *  - GOBD → COMPLIANCE: 10 Jahre echte, von niemandem aufhebbare Unveränderbarkeit
 *    (GoBD / § 147 AO), keine Frühlöschung vorgesehen.
 */
function lockModeForTier(tier: ProtectionTier): 'GOVERNANCE' | 'COMPLIANCE' {
  return tier === 'GWG' ? 'GOVERNANCE' : 'COMPLIANCE';
}

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface CommitDocumentResult {
  targetBucket: string;
  targetKey: string;
  sha256: Buffer;
  sizeBytes: bigint;
  immutable: boolean;
  retentionUntil: Date | null;
  /**
   * M-2: tatsächlich detektierte MIME aus den Magic-Bytes (oder null wenn
   * Format nicht erkannt). Routes sollten den detektierten Wert dem vom
   * Client gemeldeten vorziehen — sonst kann jemand text/html als
   * image/jpeg deklarieren und Browser-Sniffing missbrauchen.
   */
  detectedMime: string | null;
}

export type ScanResult = 'CLEAN' | 'INFECTED' | 'ERROR';

// Upload-Cap. Begrenzt sowohl Buffer-in-Memory (OOM-Schutz beim ClamAV-Scan)
// als auch Storage-/Bandbreitenmissbrauch. 100 MB ist großzügig für typische
// Belege, BWA-PDFs, Scans — größere Pakete sollten via Dokumenten-Upload-Job
// (Worker) oder DATEV-Schnittstelle laufen, nicht über den Browser-Upload.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// M-2: Magic-Number-Validierung. Verhindert, dass jemand image/jpeg deklariert,
// aber tatsächlich HTML hochlädt — moderne Browser sniffen unter Umständen
// trotz Content-Type-Header und würden das als HTML rendern. Magic-Numbers
// sind die ersten Bytes typischer Dateiformate.
const MAGIC_NUMBERS: ReadonlyArray<{ mime: string; bytes: ReadonlyArray<number | null> }> = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },                  // %PDF-
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },      // PNG
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },                                   // JPEG
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },                              // GIF8
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] }, // RIFF....WEBP
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },                             // II*\0 (LE)
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },                             // MM\0* (BE)
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },                        // PK.. (xlsx/docx/zip)
  { mime: 'application/x-tika-ooxml', bytes: [0x50, 0x4b, 0x03, 0x04] },               // PK..
  { mime: 'application/xml', bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c] },                  // <?xml
  { mime: 'text/plain', bytes: [] },                                                   // kein Header
];

/**
 * Prüft, ob die ersten Bytes der Datei zur gemeldeten MIME-Type passen.
 * Liefert die erkannte MIME oder null wenn keine bekannt. Bei `expectedMime`
 * darf nur passieren, wenn das erkannte MIME dazu passt oder text/plain ist
 * (Defense in Depth — wir verlassen uns nicht auf den Client-mimeType).
 */
export function detectMimeFromMagicBytes(data: Buffer): string | null {
  for (const sig of MAGIC_NUMBERS) {
    if (sig.bytes.length === 0) continue;
    if (data.length < sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      const expected = sig.bytes[i];
      if (expected === null) continue; // wildcard
      if (data[i] !== expected) { match = false; break; }
    }
    if (match) return sig.mime;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ClamAV-Scan via TCP (INSTREAM-Protokoll)
// ---------------------------------------------------------------------------

async function scanWithClamAV(data: Buffer): Promise<ScanResult> {
  return new Promise((resolve) => {
    const socket = createConnection(
      { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT },
      () => {
        // INSTREAM-Protokoll: zINSTREAM\0 + chunks + zero-length-chunk
        socket.write(Buffer.from('zINSTREAM\0'));

        const chunkSize = 4096;
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          const chunk = data.subarray(offset, offset + chunkSize);
          const lenBuf = Buffer.allocUnsafe(4);
          lenBuf.writeUInt32BE(chunk.length, 0);
          socket.write(lenBuf);
          socket.write(chunk);
        }
        // Terminator: 4-byte zero
        socket.write(Buffer.alloc(4));
      },
    );

    let response = '';
    // Niedrig: settle-once-Guard — wenn 'end' und 'close' (oder 'error') beide
    // feuern, würde resolve() doppelt laufen. Plus: bei RST/abrupt-close ohne
    // 'end' hing das Promise bisher bis zum 30s-Timeout. 'close' resolved
    // jetzt auch.
    let settled = false;
    const settle = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.on('data', (d: Buffer) => {
      response += d.toString('utf8');
    });
    socket.on('end', () => {
      // ClamAV antwortet null-terminiert (`stream: OK\0`); String#trim() lässt
      // das \0 stehen → endsWith('OK') schlägt fehl. Erst Nullbytes raus,
      // dann normales trim.
      const trimmed = response.replace(/\0+$/g, '').trim();
      if (trimmed.endsWith('OK')) {
        settle('CLEAN');
      } else if (trimmed.includes('FOUND')) {
        settle('INFECTED');
      } else {
        settle('ERROR');
      }
    });
    socket.on('error', () => {
      settle('ERROR');
    });
    socket.on('close', () => {
      // Falls 'end' nicht gefeuert hat (RST, abruptes Close), nicht ewig
      // warten. Wenn 'end' schon settled hat, ist das ein No-Op.
      settle('ERROR');
    });
    socket.setTimeout(30_000, () => {
      settle('ERROR');
    });
  });
}

// ---------------------------------------------------------------------------
// Filename-Sanitizer für Content-Disposition
// ---------------------------------------------------------------------------

/**
 * Defense in Depth gegen Header-Injection (S17): filename darf weder CR/LF
 * noch Backslash/Quote enthalten, sonst kann ein bösartiger Dateiname
 * zusätzliche Response-Header smuggeln. Die Download-Routes reichen den Wert
 * via Template-String direkt in den Content-Disposition-Header ein.
 *
 * Exportiert (N6), damit preview-mime.ts denselben Sanitizer verwendet —
 * vorher hatten wir zwei abweichende Whitelisten für denselben Header.
 */
export function sanitizeFilenameForHeader(name: string): string {
  // Ab CR/LF alles verwerfen: ein Angreifer darf keinen pseudo-Header-Namen
  // hinter dem Zeilenumbruch in den sichtbaren Dateinamen retten.
  const firstLine = name.split(/[\r\n]/)[0] ?? '';
  // \\, " entfernen; auch Control-Chars (0x00-0x1F) raus.
  // Zusätzlich Non-Latin-1 (>= U+0100) ersetzen: HTTP-Header-Werte müssen
  // ByteString (<=255) sein, sonst wirft Node "Cannot convert argument to a
  // ByteString" (z. B. EM DASH U+2014 in "Vollmacht — …"). Betrifft Preview-
  // und Download-Content-Disposition. Umlaute (äöüß <=255) bleiben erhalten.
  return (
    firstLine
      .replace(/[\u0100-\uFFFF]/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[\\"\x00-\x1F]/g, '')
      .trim()
      .slice(0, 200) || 'download'
  );
}

// ---------------------------------------------------------------------------
// Direkter Bytes-Download (für Server-side Aggregationen wie ZIP-Exporte)
// ---------------------------------------------------------------------------

export async function fetchObjectBytes(bucket: string, storageKey: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
  if (typeof result.ContentLength === 'number' && result.ContentLength > MAX_UPLOAD_BYTES) {
    throw new Error(`TOO_LARGE: Objekt (${result.ContentLength} B) überschreitet das Limit.`);
  }
  const body = result.Body as Readable;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    received += buf.length;
    if (received > MAX_UPLOAD_BYTES) {
      body.destroy();
      throw new Error(`TOO_LARGE: Objekt überschreitet das Limit (Streaming).`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Löscht ein Objekt aus dem Store. Bei Object-Lock-COMPLIANCE-Buckets (GOBD/GWG)
 * gelingt das NUR, wenn das Retain-Until bereits abgelaufen ist — davor verweigert
 * S3 die Löschung (by design, revisionssicher). Für die GwG-Pflichtlöschung nach
 * Fristablauf (§ 8 Abs. 4) bzw. allgemeine Lifecycle-Bereinigung.
 */
export async function deleteObject(bucket: string, storageKey: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
}

export interface ObjectStream {
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentType: string | null;
}

/**
 * Streaming-Pendant zu fetchObjectBytes: reicht den S3-Body als Web-
 * ReadableStream durch — O(1)-Speicher statt die ganze Datei in einen Buffer zu
 * sammeln. Für Download-/Preview-Routen, die direkt in die HTTP-Response streamen
 * (App-proxied; der Object-Store bleibt intern, nie öffentlich).
 *
 * Größen-Cap vorab über ContentLength. Anders als fetchObjectBytes wird NICHT
 * pro Chunk nachgedeckelt — die Quelle ist der interne, vertrauenswürdige
 * Object-Store; der Cap ist DoS-Vorsorge, kein Schutz vor manipuliertem Upstream.
 */
export async function streamObject(bucket: string, storageKey: string): Promise<ObjectStream> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
  const contentLength = typeof result.ContentLength === 'number' ? result.ContentLength : null;
  if (contentLength !== null && contentLength > MAX_UPLOAD_BYTES) {
    throw new Error(`TOO_LARGE: Objekt (${contentLength} B) überschreitet das Limit.`);
  }
  const body = Readable.toWeb(result.Body as Readable) as ReadableStream<Uint8Array>;
  return { body, contentLength, contentType: result.ContentType ?? null };
}

/**
 * Direkter Bytes-Upload OHNE Virus-Scan/Dokument-Semantik — für intern erzeugte
 * Blobs (z. B. gzip-rawResult, Subsumtions-Archiv). NICHT für Mandanten-Uploads
 * (die laufen über commitBytesWithTier/commitDocumentFromBytes inkl. ClamAV-Scan).
 *
 * `retainUntil` setzt Object-Lock COMPLIANCE (revisionssicher bis zu dem Datum) —
 * der Ziel-Bucket MUSS Object-Lock-fähig sein (GoBD/GwG-Buckets sind es).
 */
export async function putObjectBytes(
  bucket: string,
  storageKey: string,
  bytes: Buffer,
  opts: { contentType?: string; retainUntil?: Date | null } = {},
): Promise<void> {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`TOO_LARGE: Objekt (${bytes.length} B) überschreitet das Limit.`);
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: bytes,
      ContentLength: bytes.length,
      ContentType: opts.contentType ?? 'application/octet-stream',
      ...(opts.retainUntil
        ? { ObjectLockMode: 'COMPLIANCE' as const, ObjectLockRetainUntilDate: opts.retainUntil }
        : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Geteilter Kern: Bytes scannen, hashen, in den Ziel-Bucket schreiben.
// Genutzt von commitBytesWithTier/commitDocumentFromBytes. ClamAV läuft
// synchron VOR dem Upload — eine infizierte Datei erreicht nie einen Bucket.
// (Den früheren Quarantäne-Zwischenschritt der Presigned-Upload-Architektur
// gibt es nicht mehr; Uploads sind app-proxied, der Object-Store ist nur
// intern erreichbar.)
// ---------------------------------------------------------------------------

async function scanHashAndUpload(
  fileData: Buffer,
  tier: ProtectionTier,
  tenantId: string,
  skipScan = false,
): Promise<CommitDocumentResult> {
  if (!skipScan) {
    const scanResult = await scanWithClamAV(fileData);
    if (scanResult === 'INFECTED') {
      throw new Error('INFECTED: Datei wurde von ClamAV als infiziert markiert.');
    }
    if (scanResult === 'ERROR') {
      throw new Error('SCAN_ERROR: ClamAV-Scan fehlgeschlagen.');
    }
  }

  const sha256 = createHash('sha256').update(fileData).digest();
  // M-2: Magic-Bytes-Detection. Caller (Route) sollte detectedMime statt der
  // Client-gemeldeten mimeType in die Document-Reihe schreiben — verhindert
  // Browser-Sniffing-Missbrauch (text/html als image/jpeg ausgeben).
  const detectedMime = detectMimeFromMagicBytes(fileData);
  // iter55: Bucket/Lock/Frist hängen an der SCHUTZSTUFE, nicht mehr an der
  // rohen Klassifikation (eigene Typen können beliebige Stufen tragen).
  const targetBucket = getBucketForTier(tier);
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const randomId = crypto.randomUUID();
  const targetKey = `tenants/${tenantId}/${tier.toLowerCase()}/${yyyy}/${mm}/${randomId}.bin`;
  const retentionUntil = retentionForTier(tier);
  const locked = tier !== 'NONE';

  await s3.send(
    new PutObjectCommand({
      Bucket: targetBucket,
      Key: targetKey,
      Body: fileData,
      ContentLength: fileData.length,
      ...(locked && retentionUntil
        ? {
            ObjectLockMode: lockModeForTier(tier),
            ObjectLockRetainUntilDate: retentionUntil,
          }
        : {}),
    }),
  );

  return {
    targetBucket,
    targetKey,
    sha256: Buffer.from(sha256),
    sizeBytes: BigInt(fileData.length),
    immutable: locked,
    retentionUntil,
    detectedMime,
  };
}

// ---------------------------------------------------------------------------
// Direkter Bytes-Commit (für Public-Wizard / Server-Action-Uploads)
// ---------------------------------------------------------------------------

/**
 * iter55: Tier-getriebener Commit. Die Schutzstufe (NONE/GWG/GOBD) bestimmt
 * Bucket + Object-Lock + Aufbewahrung. Eigene Datei-Typen tragen ihre Stufe
 * selbst — der Caller löst Typ → Stufe auf und übergibt sie hier.
 */
export async function commitBytesWithTier(input: {
  fileData: Buffer;
  tier: ProtectionTier;
  tenantId: string;
  /** ClamAV-Scan überspringen — NUR für Bytes, die die App selbst erzeugt hat
   *  (kein Nutzer-Upload). Vermeidet unnötige TCP-Roundtrips und mögliche
   *  Hänger beim Scan der eigenen PDF (z. B. ZUGFeRD-Archiv). */
  skipScan?: boolean;
}): Promise<CommitDocumentResult> {
  const { fileData, tier, tenantId, skipScan } = input;
  if (fileData.length > MAX_UPLOAD_BYTES) {
    throw new Error(`TOO_LARGE: Datei überschreitet das Limit von ${MAX_UPLOAD_BYTES} Bytes.`);
  }
  return scanHashAndUpload(fileData, tier, tenantId, skipScan);
}

/**
 * Back-Compat: nimmt weiterhin eine Klassifikation und mappt sie auf die
 * gesetzlich fixe Stufe der 7 Kern-Typen. Aufrufer mit eigenen Typen sollten
 * `commitBytesWithTier` nutzen.
 */
export async function commitDocumentFromBytes(input: {
  fileData: Buffer;
  classification: string;
  tenantId: string;
}): Promise<CommitDocumentResult> {
  const { fileData, classification, tenantId } = input;
  return commitBytesWithTier({
    fileData,
    tier: classificationToTier(classification),
    tenantId,
  });
}
