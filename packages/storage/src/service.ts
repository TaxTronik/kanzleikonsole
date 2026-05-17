import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
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
 * Operations-Sache, nicht Object-Lock-Sache). Zusätzlich: nach Mandanten-
 * Ende muss die Kanzlei einen Lifecycle-Job laufen lassen, der Object-Lock
 * abschaltet und Dateien tatsächlich löscht.
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

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface CommitDocumentInput {
  quarantineBucket: string;
  quarantineKey: string;
  classification: string;
  tenantId: string;
  fileName: string;
}

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
// (Worker) oder DATEV-Schnittstelle laufen, nicht über Quarantine-PUT.
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
  // \r, \n, \\, " entfernen; auch Control-Chars (0x00-0x1F) raus
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\r\n\\"\x00-\x1F]/g, '').slice(0, 200) || 'download';
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

// ---------------------------------------------------------------------------
// Geteilter Kern: Bytes scannen, hashen, in den Ziel-Bucket schreiben.
// Wird sowohl von commitDocument (Quarantäne-Pfad) als auch von
// commitDocumentFromBytes (direkter Pfad) genutzt. Caller ist für Cleanup
// (z. B. Quarantäne-Datei löschen) verantwortlich.
// ---------------------------------------------------------------------------

async function scanHashAndUpload(
  fileData: Buffer,
  tier: ProtectionTier,
  tenantId: string,
): Promise<CommitDocumentResult> {
  const scanResult = await scanWithClamAV(fileData);
  if (scanResult === 'INFECTED') {
    throw new Error('INFECTED: Datei wurde von ClamAV als infiziert markiert.');
  }
  if (scanResult === 'ERROR') {
    throw new Error('SCAN_ERROR: ClamAV-Scan fehlgeschlagen.');
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
            ObjectLockMode: 'COMPLIANCE' as const,
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
}): Promise<CommitDocumentResult> {
  const { fileData, tier, tenantId } = input;
  if (fileData.length > MAX_UPLOAD_BYTES) {
    throw new Error(`TOO_LARGE: Datei überschreitet das Limit von ${MAX_UPLOAD_BYTES} Bytes.`);
  }
  return scanHashAndUpload(fileData, tier, tenantId);
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

// ---------------------------------------------------------------------------
// Commit: Quarantine → Target-Bucket
// ---------------------------------------------------------------------------

export async function commitDocument(
  input: CommitDocumentInput,
): Promise<CommitDocumentResult> {
  const { quarantineBucket, quarantineKey, classification, tenantId } = input;

  // C3: quarantineBucket MUSS der Quarantäne-Bucket sein. Sonst kann ein
  // Mandant mit gültiger Session ein Objekt aus gobd/staff-private (per
  // geratener Storage-Key-UUID innerhalb desselben Tenants) als „neues
  // GENERAL-Dokument" zurück-committen — im Portal-Pfad reale Eskalation
  // (Mandant sieht plötzlich GoBD-Belege als eigenes Portal-Dokument).
  if (quarantineBucket !== env.S3_BUCKET_QUARANTINE) {
    throw new Error(`FORBIDDEN: quarantineBucket muss '${env.S3_BUCKET_QUARANTINE}' sein.`);
  }

  // Defense in Depth: Caller-Body trägt quarantineKey aus dem Presign-Response,
  // aber ein böser Mandant könnte einen fremden Key (sofern erraten/erspäht)
  // einreichen. Keys werden mit `tenants/<tenantId>/...` generiert — hier
  // erzwingen, dass der eingelieferte Key zum Session-Tenant passt.
  const expectedPrefix = `tenants/${tenantId}/`;
  if (!quarantineKey.startsWith(expectedPrefix)) {
    throw new Error('FORBIDDEN: quarantineKey gehört nicht zum Session-Tenant.');
  }

  const deleteQuarantine = () =>
    s3.send(new DeleteObjectCommand({ Bucket: quarantineBucket, Key: quarantineKey }));

  // 1. Datei aus Quarantine laden — Größen-Cap vor dem Streaming
  const getResult = await s3.send(
    new GetObjectCommand({ Bucket: quarantineBucket, Key: quarantineKey }),
  );

  // SeaweedFS liefert ContentLength im Response — wenn größer als Cap, gar
  // nicht erst streamen.
  if (typeof getResult.ContentLength === 'number' && getResult.ContentLength > MAX_UPLOAD_BYTES) {
    await deleteQuarantine();
    throw new Error(`TOO_LARGE: Datei (${getResult.ContentLength} B) überschreitet das Limit von ${MAX_UPLOAD_BYTES} B.`);
  }

  const bodyStream = getResult.Body as Readable;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of bodyStream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    received += buf.length;
    // Streaming-Guard: bricht auch ab, wenn S3 die ContentLength falsch
    // angegeben oder weggelassen hat.
    if (received > MAX_UPLOAD_BYTES) {
      bodyStream.destroy();
      await deleteQuarantine();
      throw new Error(`TOO_LARGE: Datei überschreitet das Limit von ${MAX_UPLOAD_BYTES} B (Streaming).`);
    }
    chunks.push(buf);
  }
  const fileData = Buffer.concat(chunks);

  // 2. Scan + Hash + Upload (gemeinsamer Kern).
  // Bei INFECTED zusätzlich die Quarantine-Datei löschen — bei SCAN_ERROR
  // bewusst NICHT löschen, damit Admins die Datei forensisch prüfen können.
  let result: CommitDocumentResult;
  try {
    result = await scanHashAndUpload(fileData, classificationToTier(classification), tenantId);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('INFECTED')) {
      await deleteQuarantine();
    }
    throw e;
  }

  // 3. Erfolg → Quarantine-Datei aufräumen
  await deleteQuarantine();
  return result;
}
