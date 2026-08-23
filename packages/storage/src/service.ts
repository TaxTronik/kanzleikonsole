import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { env } from '@taxtronik/config';
import { s3, classificationToTier, getBucketForTier, type ProtectionTier } from './client';

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
 * BEG IV (Viertes Bürokratieentlastungsgesetz, seit 01.01.2025): die
 * Aufbewahrungsfrist für BUCHUNGSBELEGE (§ 147 Abs. 3 AO n.F.) und RECHNUNGEN
 * (§ 14b Abs. 1 UStG n.F.) wurde von 10 auf 8 Jahre verkürzt. Bücher,
 * Abschlüsse und die übrigen buchungsrelevanten Unterlagen bleiben bei 10.
 * Object-Lock ist COMPLIANCE (irreversibel) → eine pauschale 10-Jahres-Frist
 * für Rechnungen wäre Über-Aufbewahrung personenbezogener Daten ohne
 * Rechtsgrundlage (Art. 5 Abs. 1 lit. e DSGVO).
 */
const GOBD_RETENTION_YEARS_BY_CLASSIFICATION: Record<string, number> = {
  GOBD_INVOICE: 8, // Rechnung/Buchungsbeleg — BEG IV
  // Handels-/Geschäftsbriefe und sonstige steuerrelevante Unterlagen fallen
  // nach § 147 Abs. 3 AO grundsätzlich in die Sechsjahresgruppe. Längere
  // Spezialfälle werden als eigener Dateityp mit 8/10 Jahren modelliert.
  GOBD_CONTRACT: 6,
  GOBD_TAX: 10,
};

export function gobdRetentionYears(classification?: string): number {
  if (classification && classification in GOBD_RETENTION_YEARS_BY_CLASSIFICATION) {
    return GOBD_RETENTION_YEARS_BY_CLASSIFICATION[classification]!;
  }
  return 10;
}

/** Wie gobdRetentionUntil, aber belegart-abhängig (8 J. für Rechnungen). */
export function gobdRetentionUntilFor(classification?: string, now: Date = new Date()): Date {
  const startYear = now.getUTCFullYear();
  return new Date(Date.UTC(startYear + gobdRetentionYears(classification) + 1, 0, 1, 0, 0, 0, 0));
}

/** Friststichtag für einen fachlich klassifizierten 6-/8-/10-Jahres-Typ. */
export function retentionUntilForYears(years: number, now: Date = new Date()): Date {
  if (![5, 6, 8, 10].includes(years)) {
    throw new Error('INVALID_RETENTION_YEARS: Erlaubt sind 5, 6, 8 oder 10 Jahre.');
  }
  return new Date(Date.UTC(now.getUTCFullYear() + years + 1, 0, 1, 0, 0, 0, 0));
}

/**
 * § 8 Abs. 4 GwG schreibt grundsätzlich 5 Jahre Aufbewahrung vor; andere
 * gesetzliche Vorschriften können länger verpflichten, spätestens nach zehn
 * Jahren sind die Aufzeichnungen zu vernichten. Der fachliche Fristbeginn
 * hängt insbesondere vom Ende der Geschäftsbeziehung ab und wird deshalb von
 * der GwG-Retention-Queue geführt — dieser technische Lock ab Upload ist nur
 * eine zusätzliche Mindestbarriere, nicht die Löschentscheidung.
 *
 * Wir setzen Object-Lock-Retain-Until daher auf 5 Jahre + 1 Tag (Jahresende
 * basierte Berechnung wäre für GwG-Akten weniger relevant — Frist beginnt
 * mit Ende der Geschäftsbeziehung, nicht mit Erstellungsjahr; das ist eine
 * Operations-Sache, nicht Object-Lock-Sache).
 *
 * Object-Lock-Modus je Stufe (siehe lockModeForTier): GwG-Belege werden im
 * Modus GOVERNANCE geschrieben, GOBD in COMPLIANCE. GOVERNANCE erlaubt die
 * kontrollierte Löschung zum von der Retention-Queue ermittelten tatsächlichen
 * Fristende; COMPLIANCE könnte einen falsch zu spät gesetzten technischen Lock
 * selbst nach Eintritt der gesetzlichen Vernichtungspflicht nicht korrigieren.
 * NOCH OFFEN (Ops): die eigentliche Frühlöschung nach Beziehungsende ist ein
 * Lifecycle-Schritt (Löschen MIT BypassGovernanceRetention); zudem SeaweedFS'
 * Object-Lock-Emulation gegen reales S3-GOVERNANCE-Verhalten prüfen.
 */
export function gwgRetentionUntil(now: Date = new Date()): Date {
  const startYear = now.getUTCFullYear();
  return new Date(Date.UTC(startYear + 5 + 1, 0, 1, 0, 0, 0, 0));
}

export function retentionForTier(tier: ProtectionTier): Date | null {
  if (tier === 'GOBD') return gobdRetentionUntil();
  if (tier === 'GWG') return gwgRetentionUntil();
  return null;
}

/**
 * Object-Lock-Modus je Schutzstufe (Review F2):
 *  - GWG  → GOVERNANCE: kontrollierte Löschung zum fachlich ermittelten
 *    Fristende bleibt möglich; ohne Bypass-Recht unveränderbar.
 *  - GOBD → COMPLIANCE: echte, von niemandem aufhebbare Unveränderbarkeit für
 *    die klassifizierte 6-/8-/10-Jahresfrist (§ 147 AO/§ 14b UStG).
 */
export function lockModeForTier(tier: ProtectionTier): 'GOVERNANCE' | 'COMPLIANCE' {
  return tier === 'GWG' ? 'GOVERNANCE' : 'COMPLIANCE';
}

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface CommitDocumentResult {
  targetBucket: string;
  targetKey: string;
  storageVersionId: string | null;
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

/**
 * Vollstaendig gescannte und gehashte Upload-Absicht mit festem Zielschluessel.
 * Aufrufer koennen diese Metadaten vor dem Object-Store-Write dauerhaft als
 * PENDING persistieren. Damit bleibt ein geschuetztes Objekt selbst dann
 * auffindbar, wenn der Prozess nach dem S3-Commit abbricht.
 */
export type PreparedBytesCommit = Omit<CommitDocumentResult, 'storageVersionId'> & {
  tier: ProtectionTier;
  tenantId: string;
};

export type ScanResult = 'CLEAN' | 'INFECTED' | 'ERROR';

// Upload-Cap. Begrenzt sowohl Buffer-in-Memory (OOM-Schutz beim ClamAV-Scan)
// als auch Storage-/Bandbreitenmissbrauch. Die App puffert Multipart und Datei
// derzeit noch im Prozess; 25 MiB begrenzen deshalb den OOM-Radius. Größere
// Pakete gehören in einen künftig streamingfähigen Import-Job, nicht in den
// synchronen Browser-Upload.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// M-2: Magic-Number-Validierung. Verhindert, dass jemand image/jpeg deklariert,
// aber tatsächlich HTML hochlädt — moderne Browser sniffen unter Umständen
// trotz Content-Type-Header und würden das als HTML rendern. Magic-Numbers
// sind die ersten Bytes typischer Dateiformate.
const MAGIC_NUMBERS: ReadonlyArray<{ mime: string; bytes: ReadonlyArray<number | null> }> = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // PNG
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  {
    mime: 'image/webp',
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  }, // RIFF....WEBP
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] }, // II*\0 (LE)
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // MM\0* (BE)
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK.. (xlsx/docx/zip)
  { mime: 'application/x-tika-ooxml', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK..
  { mime: 'application/xml', bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c] }, // <?xml
  { mime: 'text/plain', bytes: [] }, // kein Header
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
      if (data[i] !== expected) {
        match = false;
        break;
      }
    }
    if (match) return sig.mime;
  }
  return null;
}

// OOXML-Dateien (xlsx/docx/pptx) sind ZIP-Container — Magic-Bytes liefern für
// alle drei nur `application/zip`. Das ist keine Lüge, aber zu grob: die
// Inline-Vorschau und die Endungs-Rückableitung beim Download hängen an der
// konkreten MIME. Deshalb eine Stufe tiefer schauen.
const OOXML_MARKERS: ReadonlyArray<{ entry: string; mime: string }> = [
  {
    entry: 'xl/workbook.xml',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    entry: 'word/document.xml',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    entry: 'ppt/presentation.xml',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
];

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
/** ZIP-Kommentar ist auf 16 Bit begrenzt — weiter zurück muss nicht gesucht werden. */
const MAX_ZIP_COMMENT = 0xffff;
/** Reine Sicherheitsgrenze gegen präparierte Verzeichnisse. */
const MAX_CENTRAL_ENTRIES = 4096;

/**
 * Liest die Eintragsnamen aus dem Central Directory eines ZIP — ohne einen
 * einzigen Byte zu dekomprimieren. Uploads sind Mandanten-Daten; ein Inflate
 * an dieser Stelle wäre eine Zip-Bomben-Fläche im Validierungspfad.
 * Liefert null, wenn die Struktur nicht sauber lesbar ist (auch bei ZIP64).
 */
function readZipEntryNames(data: Buffer): string[] | null {
  const searchStart = Math.max(0, data.length - (EOCD_MIN_SIZE + MAX_ZIP_COMMENT));
  let eocd = -1;
  for (let i = data.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = data.readUInt16LE(eocd + 10);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  // 0xFFFF/0xFFFFFFFF signalisieren ZIP64 — dann fehlen die echten Werte hier.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) return null;
  if (directoryOffset >= data.length) return null;

  const names: string[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount && i < MAX_CENTRAL_ENTRIES; i++) {
    if (cursor + 46 > data.length) return null;
    if (data.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) return null;
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > data.length) return null;
    names.push(data.toString('utf8', nameStart, nameStart + nameLength));
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * Verfeinert `application/zip` zur konkreten OOXML-MIME. Kein Treffer heißt:
 * es bleibt ein gewöhnliches ZIP.
 */
export function detectOoxmlMime(data: Buffer): string | null {
  const names = readZipEntryNames(data);
  if (names === null) return null;
  const entries = new Set(names);
  for (const marker of OOXML_MARKERS) {
    if (entries.has(marker.entry)) return marker.mime;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ClamAV-Scan via TCP (INSTREAM-Protokoll)
// ---------------------------------------------------------------------------

async function scanWithClamAV(data: Buffer): Promise<ScanResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT }, () => {
      // INSTREAM-Protokoll: zINSTREAM\0 + <len-prefix><chunk>… + zero-length-chunk.
      //
      // N-6: clamd bricht den Stream mit INSTREAM size limit exceeded ab, sobald
      // die Gesamtmenge StreamMaxLength (clamd.conf-Default 25 MB) übersteigt —
      // MAX_UPLOAD_BYTES liegt bei 25 MiB. Damit Grenzfälle inklusive Protokoll-
      // Overhead nicht als SCAN_ERROR enden, MUSS clamd mit StreamMaxLength
      // oberhalb dieses Limits deployt werden. Diese
      // Deploy-Konfig lebt außerhalb dieses Pakets (clamd.conf), darf beim
      // Rollout aber nicht vergessen werden.
      //
      // N-8: Backpressure. Große Dateien (bis MAX_UPLOAD_BYTES) dürfen nicht in
      // einer Schleife blind in den Socket-Puffer geschrieben werden — sonst
      // wächst der Kernel-/Node-Write-Puffer unkontrolliert. Wir respektieren
      // den Rückgabewert von socket.write() und warten bei `false` auf 'drain',
      // bevor der nächste Chunk folgt. Die INSTREAM-Semantik (4-Byte-BE-
      // Längenpräfix je Chunk, abschließender 4-Byte-Null-Terminator) bleibt
      // dabei exakt erhalten — nur das Schreiben wird gedrosselt.
      const chunkSize = 4096;

      const writeWithBackpressure = (buf: Buffer): Promise<void> =>
        new Promise((resolveWrite) => {
          if (socket.write(buf)) {
            resolveWrite();
          } else {
            socket.once('drain', resolveWrite);
          }
        });

      void (async () => {
        try {
          await writeWithBackpressure(Buffer.from('zINSTREAM\0'));

          for (let offset = 0; offset < data.length; offset += chunkSize) {
            const chunk = data.subarray(offset, offset + chunkSize);
            const lenBuf = Buffer.allocUnsafe(4);
            lenBuf.writeUInt32BE(chunk.length, 0);
            await writeWithBackpressure(lenBuf);
            await writeWithBackpressure(chunk);
          }

          // Terminator: 4-byte zero
          await writeWithBackpressure(Buffer.alloc(4));
        } catch {
          // Schreib-/Socket-Fehler werden über das 'error'-Event unten in ein
          // settle('ERROR') überführt; hier nichts weiter zu tun.
        }
      })();
    });

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

/**
 * Öffentlicher Wrapper um den internen ClamAV-INSTREAM-Scan — nutzt EXAKT
 * denselben Pfad wie die Upload-Pipeline (Chunking, Backpressure, StreamMax-
 * Length-Verhalten). Für den Deploy-Readiness-Check (deploy-readiness.ts):
 * dort wird u. a. mit einem Payload in App-Upload-Größe geprüft, ob clamd
 * `StreamMaxLength` >= `MAX_UPLOAD_BYTES` deployt ist (N-6), und mit EICAR, ob
 * überhaupt Signaturen geladen sind.
 */
export async function scanBytes(data: Buffer): Promise<ScanResult> {
  return scanWithClamAV(data);
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

async function readObjectBodyWithLimit(
  body: Readable,
  contentLength: number | undefined,
): Promise<Buffer> {
  if (typeof contentLength === 'number' && contentLength > MAX_UPLOAD_BYTES) {
    // Stream schliessen, bevor geworfen wird — sonst bleibt die S3-Verbindung
    // offen, bis GC oder Socket-Timeout greifen. Der Streaming-Zweig unten
    // macht es bereits richtig; diese Vorab-Pruefung tat es nicht.
    body.destroy();
    throw new Error(`TOO_LARGE: Objekt (${contentLength} B) überschreitet das Limit.`);
  }
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

export async function fetchObjectBytes(bucket: string, storageKey: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
  return readObjectBodyWithLimit(result.Body as Readable, result.ContentLength);
}

/**
 * Löscht ein Objekt aus dem Store. GOBD liegt unter COMPLIANCE, GwG unter
 * GOVERNANCE; ohne Governance-Bypass gelingt die Löschung jeweils erst nach
 * Retain-Until. Für die GwG-Pflichtlöschung nach Fristablauf (§ 8 Abs. 4)
 * beziehungsweise allgemeine Lifecycle-Bereinigung.
 */
export async function deleteObject(bucket: string, storageKey: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
}

/**
 * Löscht exakt die persistierte S3-Objektversion und verifiziert anschließend,
 * dass genau diese Version nicht mehr als Inhaltsversion oder Delete Marker
 * vorhanden ist. Andere legitime Versionen desselben Schlüssels dürfen
 * bestehen bleiben. Ohne VersionId wäre ein Delete in versionierten Buckets
 * nur ein unsichtbar machender Marker und keine physische Vernichtung.
 */
export async function deleteObjectVersion(
  bucket: string,
  storageKey: string,
  storageVersionId: string,
  options: { bypassGovernanceRetention?: boolean } = {},
): Promise<void> {
  if (!storageVersionId.trim()) {
    throw new Error('STORAGE_VERSION_ID_MISSING: Physische Löschung nicht nachweisbar.');
  }

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      VersionId: storageVersionId,
      ...(options.bypassGovernanceRetention ? { BypassGovernanceRetention: true } : {}),
    }),
  );

  for await (const page of listObjectVersionPages(bucket, storageKey)) {
    const exactVersionRemains =
      page.Versions?.some(
        (item) => item.Key === storageKey && item.VersionId === storageVersionId,
      ) ?? false;
    const exactMarkerRemains =
      page.DeleteMarkers?.some(
        (item) => item.Key === storageKey && item.VersionId === storageVersionId,
      ) ?? false;
    if (exactVersionRemains || exactMarkerRemains) {
      throw new Error(
        'STORAGE_DELETE_INCOMPLETE: Zielversion oder zugehöriger Delete Marker ist verblieben.',
      );
    }
  }
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
    // Body schliessen, bevor geworfen wird: er wurde nie in einen Web-Stream
    // ueberfuehrt und niemand konsumiert ihn — die Verbindung bliebe sonst bis
    // zum Socket-Timeout stehen.
    (result.Body as Readable | undefined)?.destroy?.();
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
 * `retainUntil` setzt Object-Lock (revisionssicher bis zu dem Datum) — der
 * Ziel-Bucket MUSS Object-Lock-fähig sein (GoBD/GwG-Buckets sind es).
 *
 * N-7: Der Lock-Modus wird NICHT mehr hart auf COMPLIANCE verdrahtet, sondern
 * aus dem `tier` via `lockModeForTier` abgeleitet (GWG → GOVERNANCE, sonst
 * COMPLIANCE). Ohne `tier` bleibt COMPLIANCE der sichere Default (Back-Compat
 * für bestehende GoBD-Aufrufer). GwG-Objekte MÜSSEN `tier: 'GWG'` übergeben,
 * damit die von § 8 Abs. 4 Satz 4 GwG geforderte Frühlöschung technisch möglich
 * bleibt (siehe lockModeForTier).
 */
export async function putObjectBytes(
  bucket: string,
  storageKey: string,
  bytes: Buffer,
  opts: { contentType?: string; retainUntil?: Date | null; tier?: ProtectionTier } = {},
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
        ? {
            ObjectLockMode: opts.tier ? lockModeForTier(opts.tier) : ('COMPLIANCE' as const),
            ObjectLockRetainUntilDate: opts.retainUntil,
          }
        : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Geteilter Kern: Bytes scannen und einen festen Upload vorbereiten; danach
// exakt diese Absicht in den Ziel-Bucket schreiben. ClamAV läuft synchron VOR
// dem Upload — eine infizierte Datei erreicht nie einen Bucket.
// (Den früheren Quarantäne-Zwischenschritt der Presigned-Upload-Architektur
// gibt es nicht mehr; Uploads sind app-proxied, der Object-Store ist nur
// intern erreichbar.)
// ---------------------------------------------------------------------------

export async function prepareBytesCommitWithTier(input: {
  fileData: Buffer;
  tier: ProtectionTier;
  tenantId: string;
  skipScan?: boolean;
  classification?: string;
  retentionYears?: number;
  retentionAnchor?: Date;
}): Promise<PreparedBytesCommit> {
  const { fileData, tier, tenantId, skipScan, classification, retentionYears, retentionAnchor } =
    input;
  if (fileData.length > MAX_UPLOAD_BYTES) {
    throw new Error(`TOO_LARGE: Datei überschreitet das Limit von ${MAX_UPLOAD_BYTES} Bytes.`);
  }
  if (retentionYears !== undefined) {
    if (tier === 'GOBD' && ![6, 8, 10].includes(retentionYears)) {
      throw new Error('INVALID_RETENTION_YEARS: GOBD erlaubt nur 6, 8 oder 10 Jahre.');
    }
    if (tier !== 'GOBD') {
      throw new Error('INVALID_RETENTION_YEARS: Individuelle Jahre sind nur für GOBD zulässig.');
    }
  }

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
  const magicMime = detectMimeFromMagicBytes(fileData);
  // ZIP-Container eine Stufe tiefer aufloesen, sonst landet jede xlsx/docx als
  // `application/zip` in der Reihe — ohne Inline-Vorschau und ohne Endung beim
  // Download. Die Inline-Whitelist (preview-mime) enthaelt OOXML bewusst nicht,
  // die Auslieferung bleibt also `attachment`/octet-stream.
  const detectedMime =
    magicMime === 'application/zip' ? (detectOoxmlMime(fileData) ?? magicMime) : magicMime;
  // iter55: Bucket/Lock/Frist hängen an der SCHUTZSTUFE, nicht mehr an der
  // rohen Klassifikation (eigene Typen können beliebige Stufen tragen).
  const targetBucket = getBucketForTier(tier);
  const uploadNow = new Date();
  const yyyy = uploadNow.getUTCFullYear();
  const mm = String(uploadNow.getUTCMonth() + 1).padStart(2, '0');
  const randomId = crypto.randomUUID();
  const targetKey = `tenants/${tenantId}/${tier.toLowerCase()}/${yyyy}/${mm}/${randomId}.bin`;
  // GOBD: belegart-abhängige Frist (8 J. Rechnungen, sonst 10 — BEG IV). Ohne
  // classification bleibt es bei 10 (Verhalten wie bisher). GWG/NONE: tier-Default.
  const retentionUntil =
    tier === 'GOBD'
      ? retentionYears
        ? retentionUntilForYears(retentionYears, retentionAnchor ?? uploadNow)
        : gobdRetentionUntilFor(classification, retentionAnchor ?? uploadNow)
      : retentionForTier(tier);
  const locked = tier !== 'NONE';

  return {
    tier,
    tenantId,
    targetBucket,
    targetKey,
    sha256: Buffer.from(sha256),
    sizeBytes: BigInt(fileData.length),
    immutable: locked,
    retentionUntil,
    detectedMime,
  };
}

/**
 * Schreibt exakt eine zuvor vorbereitete Upload-Absicht. Hash und Größe werden
 * erneut geprüft, damit PENDING-Metadaten und unveränderbare Bytes identisch
 * bleiben.
 */
export async function commitPreparedBytes(input: {
  fileData: Buffer;
  prepared: PreparedBytesCommit;
}): Promise<CommitDocumentResult> {
  const { fileData, prepared } = input;
  if (BigInt(fileData.length) !== prepared.sizeBytes) {
    throw new Error('PREPARED_UPLOAD_MISMATCH: Dateigröße hat sich nach dem Scan geändert.');
  }
  const actualSha256 = createHash('sha256').update(fileData).digest();
  if (!actualSha256.equals(prepared.sha256)) {
    throw new Error('PREPARED_UPLOAD_MISMATCH: Dateiinhalt hat sich nach dem Scan geändert.');
  }
  if (prepared.targetBucket !== getBucketForTier(prepared.tier)) {
    throw new Error('PREPARED_UPLOAD_MISMATCH: Ziel-Bucket passt nicht zur Schutzstufe.');
  }
  const mustBeImmutable = prepared.tier !== 'NONE';
  if (
    prepared.immutable !== mustBeImmutable ||
    (mustBeImmutable && !prepared.retentionUntil) ||
    (!mustBeImmutable && prepared.retentionUntil !== null)
  ) {
    throw new Error('PREPARED_UPLOAD_MISMATCH: Object-Lock passt nicht zur Schutzstufe.');
  }
  const expectedPrefix = `tenants/${prepared.tenantId}/${prepared.tier.toLowerCase()}/`;
  if (!prepared.targetKey.startsWith(expectedPrefix)) {
    throw new Error('PREPARED_UPLOAD_MISMATCH: Zielschlüssel passt nicht zum Mandanten.');
  }

  let putResult: PutObjectCommandOutput;
  try {
    putResult = await s3.send(
      new PutObjectCommand({
        Bucket: prepared.targetBucket,
        Key: prepared.targetKey,
        Body: fileData,
        ContentLength: fileData.length,
        // Bedingter PUT macht auch SDK-Retries nach verloren gegangener
        // Erfolgsantwort idempotent: Unter dem Intent-Key darf exakt eine
        // Objektversion entstehen.
        IfNoneMatch: '*',
        ...(prepared.immutable && prepared.retentionUntil
          ? {
              ObjectLockMode: lockModeForTier(prepared.tier),
              ObjectLockRetainUntilDate: prepared.retentionUntil,
            }
          : {}),
      }),
    );
  } catch (putError) {
    // Ein Timeout kann bedeuten, dass S3 den ersten PUT bereits committed hat.
    // Den festen Key deshalb exakt inventarisieren statt blind erneut zu
    // schreiben. Null bedeutet nachweislich: kein Objekt vorhanden.
    const recovered = await recoverPreparedBytesCommit(prepared);
    if (recovered) return recovered;
    throw putError;
  }
  const storageVersionId = await resolveStorageVersionId(
    prepared.targetBucket,
    prepared.targetKey,
    putResult.VersionId,
  );
  if (prepared.immutable && !storageVersionId) {
    throw new Error(
      'STORAGE_VERSION_ID_MISSING: Object-Lock-Upload lieferte keine nachweisbare VersionId.',
    );
  }

  return {
    targetBucket: prepared.targetBucket,
    targetKey: prepared.targetKey,
    storageVersionId,
    sha256: Buffer.from(prepared.sha256),
    sizeBytes: prepared.sizeBytes,
    immutable: prepared.immutable,
    retentionUntil: prepared.retentionUntil,
    detectedMime: prepared.detectedMime,
  };
}

/**
 * Rekonstruiert einen mehrdeutigen/abgebrochenen Prepared-Commit anhand des
 * dauerhaft journalisierten Keys. Genau eine Version mit identischen Bytes ist
 * zulässig; mehrere Versionen oder Delete-Marker bleiben ein harter Ops-Fehler.
 */
export async function recoverPreparedBytesCommit(
  prepared: PreparedBytesCommit,
): Promise<CommitDocumentResult | null> {
  const versions = new Map<string, string>();
  for await (const page of listObjectVersionPages(prepared.targetBucket, prepared.targetKey)) {
    if (page.DeleteMarkers?.some((marker) => marker.Key === prepared.targetKey)) {
      throw new Error('PREPARED_UPLOAD_DELETE_MARKER: Intent-Key enthält einen Delete-Marker.');
    }
    for (const version of page.Versions ?? []) {
      if (version.Key !== prepared.targetKey) continue;
      if (!version.VersionId || version.VersionId === 'null') {
        throw new Error('STORAGE_VERSION_ID_MISSING: Intent-Version ist nicht eindeutig belegt.');
      }
      versions.set(version.VersionId, version.VersionId);
    }
  }
  if (versions.size === 0) return null;
  if (versions.size !== 1) {
    throw new Error('PREPARED_UPLOAD_MULTIPLE_VERSIONS: Intent-Key enthält mehrere Versionen.');
  }

  const storageVersionId = versions.keys().next().value as string;
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: prepared.targetBucket,
      Key: prepared.targetKey,
      VersionId: storageVersionId,
    }),
  );
  const bytes = await readObjectBodyWithLimit(object.Body as Readable, object.ContentLength);
  const recoveredSha256 = createHash('sha256').update(bytes).digest();
  if (BigInt(bytes.length) !== prepared.sizeBytes || !recoveredSha256.equals(prepared.sha256)) {
    throw new Error(
      'PREPARED_UPLOAD_MISMATCH: Persistiertes Objekt stimmt nicht mit Intent überein.',
    );
  }

  return {
    targetBucket: prepared.targetBucket,
    targetKey: prepared.targetKey,
    storageVersionId,
    sha256: Buffer.from(prepared.sha256),
    sizeBytes: prepared.sizeBytes,
    immutable: prepared.immutable,
    retentionUntil: prepared.retentionUntil,
    detectedMime: prepared.detectedMime,
  };
}

async function resolveStorageVersionId(
  bucket: string,
  storageKey: string,
  putVersionId: string | undefined,
): Promise<string | null> {
  if (putVersionId && putVersionId !== 'null') return putVersionId;
  for await (const page of listObjectVersionPages(bucket, storageKey)) {
    const exact = page.Versions?.find(
      (item) =>
        item.Key === storageKey && item.IsLatest && item.VersionId && item.VersionId !== 'null',
    );
    if (exact?.VersionId) return exact.VersionId;
  }
  return null;
}

/**
 * ListObjectVersions ist paginiert. Gerade bei der Vernichtung darf ein alter
 * Inhalt auf einer Folgeseite nicht als "gelöscht" übersehen werden. Fehlende
 * Fortsetzungsmarker bei `IsTruncated=true` sind ebenfalls ein harter Fehler.
 */
async function* listObjectVersionPages(bucket: string, storageKey: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  for (;;) {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: storageKey,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    yield page;
    if (!page.IsTruncated) return;
    if (!page.NextKeyMarker) {
      throw new Error('STORAGE_VERSION_LIST_INCOMPLETE: Fortsetzungsmarker fehlt.');
    }
    if (page.NextKeyMarker === keyMarker && page.NextVersionIdMarker === versionIdMarker) {
      throw new Error('STORAGE_VERSION_LIST_INCOMPLETE: Fortsetzungsmarker wiederholt sich.');
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
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
  /** GOBD-Belegart für die belegart-abhängige Aufbewahrungsfrist (BEG IV:
   *  Rechnungen 8 J.). Ohne Angabe gilt bei GOBD die 10-Jahres-Frist. */
  classification?: string;
  /** Fachlich bestimmtes Aufbewahrungsintervall des Datei-Typs. Für GOBD
   *  ausschließlich 6, 8 oder 10; verhindert pauschale Zehnjahres-Locks. */
  retentionYears?: number;
  /** Fachlicher Anker des Fristbeginn-Jahres, z. B. Dokumentanlage beim
   *  Retagging. Verhindert, dass bloßes Umklassifizieren die Frist neu startet. */
  retentionAnchor?: Date;
}): Promise<CommitDocumentResult> {
  const prepared = await prepareBytesCommitWithTier(input);
  return commitPreparedBytes({ fileData: input.fileData, prepared });
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
    classification,
  });
}
