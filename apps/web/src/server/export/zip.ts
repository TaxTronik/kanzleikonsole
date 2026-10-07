// =============================================================================
// ZIP-Writer (Methode STORE — keine Kompression)
//
// Zwei Wege mit demselben Archivformat:
//   - createZipStream (P-03): streamt das Archiv Eintrag für Eintrag in die
//     HTTP-Antwort (Sammel-Download, DATEV-Belegexport). Ein Eintrag wird erst
//     gelesen, wenn der Client den vorherigen abgenommen hat; im Speicher liegt
//     höchstens ein Eintrag (Obergrenze maxEntryBytes).
//   - buildZip: puffert das ganze Archiv für Aufrufer, die die fertigen Bytes
//     selbst weiterverarbeiten (Ablage als Dokument). Die Größengrenze folgt
//     dem Speicherlimit des Prozesses (bufferedZipMaxTotalBytes).
//
// Jeder Local File Header trägt CRC-32 und Größen; es gibt keine Data
// Descriptors (Bit 3). So lesen auch reine Stream-Leser ohne Central Directory
// das Archiv, z. B. Javas ZipInputStream, der STORE-Einträge mit Data
// Descriptor ablehnt ("only DEFLATED entries can have EXT descriptor").
//
// STORE ist ausreichend: PDFs/Bilder sind bereits komprimiert, deflate würde nur
// CPU verbrennen ohne nennenswerte Größenersparnis.
//
// Spezifikation: APPNOTE.TXT 6.3.10 (PKWARE), Kompressionsmethode 0.
// CRC-32 nutzt node:zlib.crc32 (verfügbar ab Node 22.2).
// =============================================================================
import { totalmem } from 'node:os';
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string; // Dateiname im Archiv (UTF-8, Vorwärts-Slashes)
  data: Buffer;
  modifiedAt?: Date;
}

/**
 * T-4: Hard-Cap auf die Nutzlast eines ZIP-Exports. Vorher konnte buildZip eine
 * 10-Jahre-Belege-Sammlung (mehrere GB) komplett in den RAM laden → OOM. Per-Datei
 * greift zwar MAX_UPLOAD_BYTES = 25 MiB, aber kein Summen-Cap. Wir werfen ein
 * klares Error mit Empfehlung, kleinere Datumsbereiche zu wählen.
 *
 * P-03: Gestreamte Exporte (createZipStream) puffern höchstens einen Eintrag;
 * für sie ist 1 GiB ein Produktlimit für Sync-Downloads (Übertragungsdauer,
 * Slot-Belegung), kein RAM-Schutz mehr. Technisch läge die Grenze ohne ZIP64
 * knapp unter 4 GiB (ZIP32_MAX_ARCHIVE_BYTES). Gepufferte Builds begrenzt
 * zusätzlich bufferedZipMaxTotalBytes(). Größere Exporte gehören in einen
 * Async-Worker-Job, der das ZIP im Object-Store ablegt (vgl. backup-Pattern).
 */
export const ZIP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/**
 * Max. Anzahl Einträge ohne ZIP64. Das EOCD-Feld für die Entry-Zahl ist ein
 * 16-Bit-Wert (0xffff). Ohne diesen Guard würfe `writeUInt16LE` bei mehr als
 * 65.535 Dateien ERR_OUT_OF_RANGE — nachdem bereits alle Bytes im RAM sind —
 * und der Export endete in einem generischen 500. Klarer Fehler stattdessen.
 */
export const ZIP_MAX_ENTRIES = 0xffff;

export class ZipTooManyEntriesError extends Error {
  readonly entryCount: number;
  readonly limit: number;
  constructor(entryCount: number, limit: number) {
    super(
      `ZIP enthält ${entryCount} Dateien und überschreitet das Limit von ${limit} ` +
        `Einträgen. Bitte den Datumsbereich enger fassen.`,
    );
    this.name = 'ZipTooManyEntriesError';
    this.entryCount = entryCount;
    this.limit = limit;
  }
}

export class ZipTooLargeError extends Error {
  readonly totalBytes: number;
  readonly limitBytes: number;
  constructor(totalBytes: number, limitBytes: number) {
    super(
      `ZIP-Größe ${(totalBytes / 1024 / 1024).toFixed(1)} MB überschreitet das Limit ` +
        `(${(limitBytes / 1024 / 1024).toFixed(0)} MB). Bitte den Datumsbereich enger fassen.`,
    );
    this.name = 'ZipTooLargeError';
    this.totalBytes = totalBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * P-6: Modul-globale Concurrency-Limits für ZIP-Exporte je Instanz, seit P-03
 * getrennt nach Art (eigene Pools, sie blockieren sich nicht gegenseitig):
 *   - Gepufferte Builds (buildZip-Aufrufer wie Mandatsausgaben): Der Speicher
 *     wächst mit der Nutzlast (Einträge + Concat-Kopie, Grenze
 *     bufferedZipMaxTotalBytes). Da buildZip synchron ist, muss der Slot das
 *     GANZE Fetch+Build des Aufrufers umschließen: Slot holen, Bytes laden,
 *     buildZip, Slot freigeben (finally). Max. ZIP_MAX_PARALLEL_BUILDS = 2.
 *   - Gestreamte Exporte (createZipStream: Sammel-Download, DATEV-Belegexport):
 *     puffern höchstens einen Eintrag (≤ maxEntryBytes, an den Routen
 *     MAX_UPLOAD_BYTES = 25 MiB) plus Header und Central Directory, halten den
 *     Slot aber für die ganze Übertragung (bis onSettled). Max.
 *     ZIP_MAX_PARALLEL_STREAMS = 4, zusammen ≈ 100 MiB Spitze. Mit nur 2 Slots
 *     blockierten schon zwei langsame Downloads alle weiteren Exporte (429).
 * Weitere Anfragen warten kurz und brechen dann mit ZipBusyError ab (→ HTTP 429).
 */
const ZIP_MAX_PARALLEL_BUILDS = 2;
export const ZIP_MAX_PARALLEL_STREAMS = 4;
const ZIP_SLOT_WAIT_MS = 10_000;
const ZIP_SLOT_POLL_MS = 250;

export class ZipBusyError extends Error {
  constructor() {
    super(
      'Zu viele gleichzeitige ZIP-Exporte auf diesem Server. ' +
        'Bitte versuchen Sie es in wenigen Augenblicken erneut.',
    );
    this.name = 'ZipBusyError';
  }
}

function createZipSlotPool(maxParallel: number): () => Promise<() => void> {
  let active = 0;
  return async () => {
    const deadline = Date.now() + ZIP_SLOT_WAIT_MS;
    while (active >= maxParallel) {
      if (Date.now() >= deadline) throw new ZipBusyError();
      await new Promise((resolve) => setTimeout(resolve, ZIP_SLOT_POLL_MS));
    }
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  };
}

/**
 * Reserviert einen Slot für einen gepufferten ZIP-Build. Gibt die Release-
 * Funktion zurück — der Aufrufer MUSS sie in einem `finally` aufrufen. Wirft
 * ZipBusyError, wenn nach kurzem Warten kein Slot frei wird.
 */
export const acquireZipBuildSlot = createZipSlotPool(ZIP_MAX_PARALLEL_BUILDS);

/**
 * Reserviert einen Slot für einen gestreamten Export (eigener Pool, s. o.). Die
 * Release-Funktion gehört an createZipStream → onSettled; nur wenn der Stream
 * gar nicht erst entsteht, gibt der Aufrufer selbst frei. Wirft ZipBusyError,
 * wenn nach kurzem Warten kein Slot frei wird.
 */
export const acquireZipStreamSlot = createZipSlotPool(ZIP_MAX_PARALLEL_STREAMS);

/**
 * P-03: Größengrenze für gepufferte Builds (buildZip), aus dem Speicherlimit des
 * Prozesses abgeleitet: Container-/cgroup-Limit, sonst der physische Speicher.
 * Ein Build hält Einträge + Concat-Ergebnis (≈ 2 × Nutzlast); alle
 * ZIP_MAX_PARALLEL_BUILDS Builds zusammen dürfen höchstens die Hälfte des Limits
 * belegen, der Rest bleibt Node/Next.js und den gestreamten Exporten. Beim
 * Standardlimit des Web-Containers (2 GiB, APP_MEM_LIMIT) sind das 256 MiB je
 * Build; nie mehr als ZIP_MAX_TOTAL_BYTES. Gestreamte Exporte betrifft diese
 * Grenze nicht.
 */
export function bufferedZipMaxTotalBytes(
  memoryLimitBytes: number = processMemoryLimitBytes(),
): number {
  const perBuild = Math.floor(memoryLimitBytes / 2 / ZIP_MAX_PARALLEL_BUILDS / 2);
  return Math.max(0, Math.min(ZIP_MAX_TOTAL_BYTES, perBuild));
}

function processMemoryLimitBytes(): number {
  const physical = totalmem();
  // 0 = kein bzw. unbekanntes Limit; ohne cgroup-Grenze kann der Wert auch über
  // dem physischen Speicher liegen.
  const constrained = process.constrainedMemory();
  return constrained > 0 && constrained < physical ? constrained : physical;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  // Entry-Zahl gegen die 16-Bit-Grenze des EOCD prüfen (kein ZIP64 hier).
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipTooManyEntriesError(entries.length, ZIP_MAX_ENTRIES);
  }
  // T-4: Vorab-Check auf Gesamtgröße. Mit STORE-Methode (keine Kompression) ist
  // die ZIP-Größe ≈ Summe der Eingaben + Headern; das reicht für einen
  // pragmatischen Cap. Wir wollen NICHT erst alle Buffer kopieren und dann
  // im Concat OOM gehen. P-03: Grenze aus dem Speicherlimit (s. o.).
  const limitBytes = bufferedZipMaxTotalBytes();
  let total = 0;
  for (const e of entries) {
    total += e.data.length + e.name.length + 76; // ~Header-Overhead pro Entry
  }
  if (total > limitBytes) {
    throw new ZipTooLargeError(total, limitBytes);
  }
  const localChunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const sz = e.data.length;
    const dt = toDosDateTime(e.modifiedAt ?? new Date());
    const lh = localFileHeader(nameBuf, crc, sz, dt);
    localChunks.push(lh, e.data);
    central.push(centralDirectoryHeader(nameBuf, crc, sz, dt, offset));
    offset += lh.length + sz;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = endOfCentralDirectory(entries.length, cdBuf.length, offset);
  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

interface DosDateTime {
  date: number;
  time: number;
}

/** Local File Header inkl. Name — CRC-32 und Größen exakt, Bit 3 (Data Descriptor) aus. */
function localFileHeader(name: Buffer, crc: number, size: number, dt: DosDateTime): Buffer {
  const lh = Buffer.alloc(30 + name.length);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4); // version needed
  lh.writeUInt16LE(0x0800, 6); // flag: bit 11 = UTF-8 filename
  lh.writeUInt16LE(0, 8); // method: STORE
  lh.writeUInt16LE(dt.time, 10);
  lh.writeUInt16LE(dt.date, 12);
  lh.writeUInt32LE(crc >>> 0, 14);
  lh.writeUInt32LE(size, 18);
  lh.writeUInt32LE(size, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  name.copy(lh, 30);
  return lh;
}

/** Central-Directory-Eintrag inkl. Name. */
function centralDirectoryHeader(
  name: Buffer,
  crc: number,
  size: number,
  dt: DosDateTime,
  offset: number,
): Buffer {
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0x0800, 8); // flag
  cd.writeUInt16LE(0, 10); // method
  cd.writeUInt16LE(dt.time, 12);
  cd.writeUInt16LE(dt.date, 14);
  cd.writeUInt32LE(crc >>> 0, 16);
  cd.writeUInt32LE(size, 20);
  cd.writeUInt32LE(size, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  name.copy(cd, 46);
  return cd;
}

/** End of Central Directory Record (ohne ZIP64). */
function endOfCentralDirectory(entryCount: number, size: number, offset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(size, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

function toDosDateTime(d: Date): DosDateTime {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { date, time };
}

// -----------------------------------------------------------------------------
// P-03: Streaming-Export
//
// Vorher luden Sammel-Download und DATEV-Export alle Objekte in ein Array (bis
// 1 GiB), buildZip kopierte per Buffer.concat und die Route ein drittes Mal in
// die Response — Spitzenbedarf 2–3 × Nutzlast im einzigen Next.js-Prozess (2 GB
// Container). Jetzt liegt pro Export höchstens ein Eintrag im Speicher: Er wird
// vollständig gelesen (≤ maxEntryBytes, ohne Kopie der Chunks), danach stehen
// CRC-32 und Größe fest und der Local Header wird exakt geschrieben — dasselbe
// Format wie buildZip. Den nächsten Eintrag liest der Writer erst, wenn der
// Client den vorherigen abgenommen hat.
// -----------------------------------------------------------------------------

/** Ohne ZIP64 sind Offsets und Größen 32-Bit-Felder; größer wäre das Archiv kaputt. */
export const ZIP32_MAX_ARCHIVE_BYTES = 0xffffffff;

/**
 * Nimmt der Client so lange keine Daten ab, bricht der Export ab und gibt seinen
 * Slot frei — sonst blockierte ein hängender oder nie lesender Client einen
 * Export-Slot unbegrenzt. Hängende S3-Lesezugriffe begrenzt bereits der
 * socketTimeout des S3-Clients (30 s).
 */
export const ZIP_STREAM_IDLE_TIMEOUT_MS = 120_000;

export interface ZipStreamEntry {
  /** Dateiname im Archiv (UTF-8, Vorwärts-Slashes). */
  name: string;
  /** Kleine, bereits erzeugte Bytes oder ein Quell-Stream (S3), erst beim Schreiben gelesen. */
  data: Uint8Array | ReadableStream<Uint8Array>;
  modifiedAt?: Date;
  /**
   * Nur für Stream-Quellen: Scheitert das Lesen oder überschreitet die Quelle
   * maxEntryBytes, wird der Eintrag ausgelassen statt den Export abzubrechen,
   * und dieser Rückruf erhält den Grund. Möglich, weil ein Eintrag erst nach dem
   * vollständigen Lesen geschrieben wird (DATEV: Beleg im Index als „FEHLT“).
   */
  onReadError?: (error: unknown) => void;
}

export type ZipStreamOutcome = 'completed' | 'failed' | 'cancelled';

export interface ZipStreamOptions {
  /**
   * Genau ein Aufruf: nach dem letzten übertragenen Byte, nach einem Fehler oder
   * nach Abbruch durch den Client. Hier gibt der Aufrufer seinen Export-Slot frei.
   */
  onSettled?: (outcome: ZipStreamOutcome, reason?: unknown) => void;
  /** Abbruch von außen, z. B. `req.signal` beim Client-Disconnect. */
  signal?: AbortSignal;
  /**
   * Obergrenze je gestreamter Quelle (Pflicht): Bis zu dieser Größe wird ein
   * Eintrag gepuffert, sie bestimmt also den Speicherbedarf eines Exports. Die
   * Routen setzen MAX_UPLOAD_BYTES wie der geprüfte Leseweg (streamVerifiedObject).
   */
  maxEntryBytes: number;
  /** Backstop für die Summe der gestreamten Quellbytes; Default ZIP_MAX_TOTAL_BYTES. */
  maxSourceBytes?: number;
  /** Default ZIP_STREAM_IDLE_TIMEOUT_MS; 0 schaltet den Leerlauf-Abbruch ab. */
  idleTimeoutMs?: number;
}

/** Abbruch eines bereits laufenden Stream-Exports (Grenze verletzt, Client hängt). */
export class ZipStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipStreamError';
  }
}

/**
 * Erzeugt ein ZIP als ReadableStream. Einträge werden der Reihe nach angefordert
 * und vollständig gelesen, bevor sie mit exaktem Local Header geschrieben werden;
 * der nächste Eintrag folgt erst, wenn der Konsument den vorherigen abgenommen
 * hat. Es entsteht kein Gesamtpuffer. Verletzt eine Quelle eine Grenze oder
 * schlägt sie fehl (ohne onReadError), endet der Stream mit einem Fehler — nie
 * mit einem still unvollständigen Archiv.
 */
export function createZipStream(
  entries: Iterable<ZipStreamEntry> | AsyncIterable<ZipStreamEntry>,
  options: ZipStreamOptions,
): ReadableStream<Uint8Array> {
  const writer = new StreamingZipWriter(entries, options);
  return new ReadableStream<Uint8Array>({
    start: (controller) => writer.start(controller),
    pull: (controller) => writer.pull(controller),
    cancel: (reason) => writer.cancel(reason),
  });
}

interface BufferingEntry {
  entry: ZipStreamEntry;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  chunks: Uint8Array[];
  bytes: number;
  crc: number;
}

class StreamingZipWriter {
  private readonly source: Iterator<ZipStreamEntry> | AsyncIterator<ZipStreamEntry>;
  /** Fertige Archivbytes, die der Konsument noch nicht abgenommen hat (≤ ein Eintrag). */
  private readonly pending: Uint8Array[] = [];
  /** Central-Directory-Einträge (je 46 B + Name), geschrieben nach dem letzten Eintrag. */
  private readonly central: Buffer[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private current: BufferingEntry | null = null;
  private ended = false;
  private settled = false;
  private archiveBytes = 0;
  private sourceBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    entries: Iterable<ZipStreamEntry> | AsyncIterable<ZipStreamEntry>,
    private readonly options: ZipStreamOptions,
  ) {
    this.source =
      Symbol.asyncIterator in entries
        ? entries[Symbol.asyncIterator]()
        : (entries as Iterable<ZipStreamEntry>)[Symbol.iterator]();
  }

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller;
    const signal = this.options.signal;
    if (signal?.aborted) this.finish('cancelled', signal.reason);
    else signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    clearTimeout(this.idleTimer);
    if (this.settled) return;
    try {
      while (this.pending.length === 0 && !this.ended) {
        await this.step();
        if (this.settled) return;
      }
      // Ein Chunk je Pull: Gegendruck und Leerlauf-Erkennung bleiben feingranular,
      // auch wenn ein ganzer Eintrag (bis maxEntryBytes) bereitliegt.
      const chunk = this.pending.shift();
      if (chunk) controller.enqueue(chunk);
      if (this.ended && this.pending.length === 0) {
        controller.close();
        this.finish('completed');
      } else {
        this.armIdleTimer();
      }
    } catch (error) {
      this.finish('failed', error);
    }
  }

  cancel(reason: unknown): void {
    this.finish('cancelled', reason);
  }

  private readonly onAbort = (): void => {
    this.finish('cancelled', this.options.signal?.reason);
  };

  /** Ein Schritt: einen Chunk der aktuellen Quelle puffern oder den nächsten Eintrag beginnen. */
  private async step(): Promise<void> {
    const current = this.current;
    if (current) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await current.reader.read();
        if (this.settled) return;
        if (!result.done) this.buffer(current, result.value);
      } catch (error) {
        if (this.settled) return;
        this.skipOrThrow(current, error);
        return;
      }
      if (result.done) {
        this.current = null;
        this.emit(current.entry, current.chunks, current.bytes, current.crc);
      }
      return;
    }
    const next = await this.source.next();
    if (this.settled) {
      if (!next.done) discardEntry(next.value);
      return;
    }
    if (next.done) {
      this.emitCentralDirectory();
      return;
    }
    this.begin(next.value);
  }

  private begin(entry: ZipStreamEntry): void {
    if (this.central.length >= ZIP_MAX_ENTRIES) {
      discardEntry(entry);
      throw new ZipTooManyEntriesError(this.central.length + 1, ZIP_MAX_ENTRIES);
    }
    if (entry.data instanceof Uint8Array) {
      const data = entry.data;
      this.emit(entry, data.byteLength > 0 ? [data] : [], data.byteLength, crc32(data));
    } else {
      this.current = { entry, reader: entry.data.getReader(), chunks: [], bytes: 0, crc: 0 };
    }
  }

  private buffer(current: BufferingEntry, chunk: Uint8Array): void {
    current.bytes += chunk.byteLength;
    this.sourceBytes += chunk.byteLength;
    if (current.bytes > this.options.maxEntryBytes) {
      throw new ZipStreamError(
        `Eine Quelldatei überschreitet das Limit von ${this.options.maxEntryBytes} B.`,
      );
    }
    const maxSourceBytes = this.options.maxSourceBytes ?? ZIP_MAX_TOTAL_BYTES;
    if (this.sourceBytes > maxSourceBytes) {
      throw new ZipTooLargeError(this.sourceBytes, maxSourceBytes);
    }
    if (chunk.byteLength === 0) return;
    current.crc = crc32(chunk, current.crc);
    current.chunks.push(chunk);
  }

  /** Lesefehler/Größe einer Quelle: Eintrag auslassen (onReadError) oder Export abbrechen. */
  private skipOrThrow(current: BufferingEntry, error: unknown): void {
    // Die Summengrenze (P-2-Backstop) bricht immer ab — wie früher der 413.
    if (!current.entry.onReadError || error instanceof ZipTooLargeError) throw error;
    this.current = null;
    this.sourceBytes -= current.bytes;
    void current.reader.cancel(error).catch(() => undefined);
    current.entry.onReadError(error);
  }

  /** Eintrag mit exaktem Local Header (CRC, Größen) in die Ausgabe legen. */
  private emit(entry: ZipStreamEntry, chunks: Uint8Array[], size: number, crc: number): void {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff) throw new ZipStreamError('Ein Dateiname überschreitet 65.535 Bytes.');
    const dt = toDosDateTime(zipTimestamp(entry.modifiedAt));
    const header = localFileHeader(name, crc, size, dt);
    const offset = this.reserve(header.length + size);
    this.central.push(centralDirectoryHeader(name, crc, size, dt, offset));
    this.pending.push(header, ...chunks);
  }

  private emitCentralDirectory(): void {
    const entryCount = this.central.length;
    const size = this.central.reduce((sum, record) => sum + record.length, 0);
    const offset = this.reserve(size + 22);
    // Ein Puffer für Central Directory + EOCD (nur Metadaten, keine Dateibytes).
    const directory = Buffer.allocUnsafe(size + 22);
    let position = 0;
    for (const record of this.central) position += record.copy(directory, position);
    endOfCentralDirectory(entryCount, size, offset).copy(directory, position);
    this.central.length = 0;
    this.pending.push(directory);
    this.ended = true;
  }

  /** Reserviert Archivbytes und liefert deren Offset; ohne ZIP64 höchstens 4 GiB - 1. */
  private reserve(bytes: number): number {
    const offset = this.archiveBytes;
    this.archiveBytes += bytes;
    if (this.archiveBytes > ZIP32_MAX_ARCHIVE_BYTES) {
      throw new ZipTooLargeError(this.archiveBytes, ZIP32_MAX_ARCHIVE_BYTES);
    }
    return offset;
  }

  private armIdleTimer(): void {
    const timeoutMs = this.options.idleTimeoutMs ?? ZIP_STREAM_IDLE_TIMEOUT_MS;
    if (!(timeoutMs > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.finish(
        'failed',
        new ZipStreamError(`Der Client hat ${timeoutMs} ms lang keine Daten abgenommen.`),
      );
    }, timeoutMs);
    this.idleTimer.unref?.();
  }

  /** Genau einmal: Quellen schließen, Puffer freigeben, Aufrufer (Slot) informieren. */
  private finish(outcome: ZipStreamOutcome, reason?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.idleTimer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    if (outcome !== 'completed') {
      // Wartende Leser beenden; nach cancel() durch den Konsumenten ein No-op.
      try {
        this.controller?.error(reason);
      } catch {
        // Stream bereits geschlossen.
      }
      const current = this.current;
      this.current = null;
      void current?.reader.cancel(reason).catch(() => undefined);
      closeIterator(this.source);
    }
    this.pending.length = 0;
    this.central.length = 0;
    this.options.onSettled?.(outcome, reason);
  }
}

/** DOS-Zeitstempel decken 1980–2099 ab; außerhalb würde der Header-Schreiber werfen. */
function zipTimestamp(date: Date | undefined): Date {
  const value = date ?? new Date();
  const year = value.getFullYear();
  if (year < 1980) return new Date(1980, 0, 1);
  if (year > 2099) return new Date(2099, 11, 31, 23, 59, 58);
  return value;
}

function discardEntry(entry: ZipStreamEntry): void {
  if (!(entry.data instanceof Uint8Array)) void entry.data.cancel().catch(() => undefined);
}

/** Beendet den Eintragsgenerator (finally-Blöcke laufen, offene Quellen schließen). */
function closeIterator(iterator: Iterator<unknown> | AsyncIterator<unknown>): void {
  try {
    const result = iterator.return?.();
    if (result instanceof Promise) void result.catch(() => undefined);
  } catch {
    // Ein Fehler im finally des Generators ändert am Abbruch nichts mehr.
  }
}

/**
 * Säubert einen Dateinamen für die Verwendung im ZIP — entfernt
 * Pfad-Trenner, Steuerzeichen und problematische Zeichen.
 *
 * Zip-Slip-Härtung: Aufrufer setzen sanitisierte Segmente zu Archiv-Pfaden
 * zusammen (pathOf/addEntry im Dokument-Download). Ein Ordner-/Dateiname wie
 * '..' wäre dort nach dem Join ein Pfad-Navigations-Segment beim Entpacken —
 * reine Punkt-Segmente werden daher neutralisiert, führende Punkte ersetzt
 * (sonst entstehen versteckte Unix-Dotfiles).
 */
export function sanitizeZipFileName(name: string, maxLen = 100): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return 'datei';
  if (/^\.+$/.test(cleaned)) return 'datei';
  return cleaned.replace(/^\.+/, '_').slice(0, maxLen);
}

/**
 * Vergibt Dateipfade unter bereits bereinigten Ordnerpfaden. Verzeichnisse und
 * alle Elternpfade zuerst reservieren: Eine Datei namens "Belege" darf das
 * Entpacken von "Belege/2026/Original.pdf" nicht blockieren. Derselbe Namensraum
 * erfasst vergebene Suffixe sowie NFC-/Großschreibungsvarianten.
 */
export function createZipEntryPathAllocator(folderPaths: readonly string[]) {
  const pathKey = (path: string) => path.normalize('NFC').toLowerCase();
  const reserved = new Set<string>();
  for (const path of folderPaths) {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      reserved.add(pathKey(parts.slice(0, length).join('/')));
    }
  }

  return (prefix: string, filename: string): string => {
    const base = sanitizeZipFileName(filename);
    const dot = base.lastIndexOf('.');
    let leaf = base;
    let suffix = 1;
    const fullPath = () => (prefix ? `${prefix}/${leaf}` : leaf);
    while (reserved.has(pathKey(fullPath()))) {
      leaf = dot > 0 ? `${base.slice(0, dot)}_${suffix}${base.slice(dot)}` : `${base}_${suffix}`;
      suffix += 1;
    }
    const path = fullPath();
    reserved.add(pathKey(path));
    return path;
  };
}
