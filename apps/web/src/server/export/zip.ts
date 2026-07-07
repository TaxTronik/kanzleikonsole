// =============================================================================
// Minimaler ZIP-Writer (Methode STORE — keine Kompression)
//
// Vermeidet eine externe Dependency wie jszip/archiver. STORE ist hier
// ausreichend: PDFs/Bilder sind bereits komprimiert, deflate würde nur CPU
// verbrennen ohne nennenswerte Größenersparnis.
//
// Spezifikation: APPNOTE.TXT 6.3.10 (PKWARE), Kompressionsmethode 0.
// CRC-32 nutzt node:zlib.crc32 (verfügbar ab Node 22.2).
// =============================================================================
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string; // Dateiname im Archiv (UTF-8, Vorwärts-Slashes)
  data: Buffer;
  modifiedAt?: Date;
}

/**
 * T-4: Hard-Cap auf Gesamt-Bytes. Vorher konnte buildZip eine 10-Jahre-Belege-
 * Sammlung (mehrere GB) komplett in den RAM laden → OOM. Per-Datei greift zwar
 * MAX_UPLOAD_BYTES = 100 MB, aber kein Summen-Cap. Wir werfen ein klares Error
 * mit Empfehlung, kleinere Datumsbereiche zu wählen — bessere UX als ein
 * OOM-Crash der ganzen Web-Instanz.
 *
 * 1 GB ist ein pragmatisches Limit für Sync-Downloads. Größere Exporte sollten
 * über einen Async-Worker-Job laufen, der ZIP in den backups-Bucket legt und
 * den Admin per Notification informiert (vgl. backup-Pattern). Bis dahin:
 * harter Stopp + Hinweis im Response-Body.
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
 * P-6: Modul-globales Concurrency-Limit für ZIP-Builds. Ein Build hält bis zu
 * ~2 GB RAM (geladene Entries + Concat-Kopie) — ab wenigen parallelen Exporten
 * kippt die Instanz, obwohl jeder einzelne unter dem 1-GB-Cap bleibt. Da
 * buildZip synchron ist, muss der Slot das GANZE Fetch+Build des Aufrufers
 * umschließen: Slot holen, Bytes laden, buildZip, Slot freigeben (finally).
 * Max. 2 gleichzeitige Builds pro Instanz; weitere warten kurz und brechen
 * dann mit ZipBusyError ab (Aufrufer → HTTP 429).
 */
const ZIP_MAX_PARALLEL_BUILDS = 2;
const ZIP_SLOT_WAIT_MS = 10_000;
const ZIP_SLOT_POLL_MS = 250;
let activeZipBuilds = 0;

export class ZipBusyError extends Error {
  constructor() {
    super(
      'Zu viele gleichzeitige ZIP-Exporte auf diesem Server. ' +
        'Bitte versuchen Sie es in wenigen Augenblicken erneut.',
    );
    this.name = 'ZipBusyError';
  }
}

/**
 * Reserviert einen ZIP-Build-Slot. Gibt die Release-Funktion zurück — der
 * Aufrufer MUSS sie in einem `finally` aufrufen. Wirft ZipBusyError, wenn
 * nach kurzem Warten kein Slot frei wird.
 */
export async function acquireZipBuildSlot(): Promise<() => void> {
  const deadline = Date.now() + ZIP_SLOT_WAIT_MS;
  while (activeZipBuilds >= ZIP_MAX_PARALLEL_BUILDS) {
    if (Date.now() >= deadline) throw new ZipBusyError();
    await new Promise((resolve) => setTimeout(resolve, ZIP_SLOT_POLL_MS));
  }
  activeZipBuilds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeZipBuilds -= 1;
  };
}

export function buildZip(entries: ZipEntry[]): Buffer {
  // Entry-Zahl gegen die 16-Bit-Grenze des EOCD prüfen (kein ZIP64 hier).
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipTooManyEntriesError(entries.length, ZIP_MAX_ENTRIES);
  }
  // T-4: Vorab-Check auf Gesamtgröße. Mit STORE-Methode (keine Kompression) ist
  // die ZIP-Größe ≈ Summe der Eingaben + Headern; das reicht für einen
  // pragmatischen Cap. Wir wollen NICHT erst alle Buffer kopieren und dann
  // im Concat OOM gehen.
  let total = 0;
  for (const e of entries) {
    total += e.data.length + e.name.length + 76; // ~Header-Overhead pro Entry
  }
  if (total > ZIP_MAX_TOTAL_BYTES) {
    throw new ZipTooLargeError(total, ZIP_MAX_TOTAL_BYTES);
  }
  const localChunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const sz = e.data.length;
    const dt = toDosDateTime(e.modifiedAt ?? new Date());

    // Local File Header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flag: bit 11 = UTF-8 filename
    lh.writeUInt16LE(0, 8); // method: STORE
    lh.writeUInt16LE(dt.time, 10);
    lh.writeUInt16LE(dt.date, 12);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(sz, 18);
    lh.writeUInt32LE(sz, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localChunks.push(lh, nameBuf, e.data);

    // Central Directory Entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // flag
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(dt.time, 12);
    cd.writeUInt16LE(dt.date, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(sz, 20);
    cd.writeUInt32LE(sz, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + sz;
  }

  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const cdSize = cdBuf.length;

  // End of Central Directory Record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

function toDosDateTime(d: Date): { date: number; time: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { date, time };
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
