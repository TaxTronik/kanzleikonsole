// Test-Hilfe (kein Test): liest ein ZIP wie ein reiner Stream-Leser, z. B. Javas
// ZipInputStream — Local File Header von vorn, ohne vorher das Central Directory
// zu kennen. Ein solcher Leser braucht CRC-32 und Größen im Local Header; Einträge
// mit Data Descriptor (Bit 3) und STORE lehnt ZipInputStream ab.
import { crc32 } from 'node:zlib';

export interface LocalZipEntry {
  name: string;
  flags: number;
  crc: number;
  size: number;
  offset: number;
  data: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/**
 * Läuft die Local File Header nacheinander ab und wirft bei jedem Verstoß:
 * Data-Descriptor-Bit gesetzt, andere Methode als STORE, Größen oder CRC-32 im
 * Local Header passen nicht zu den folgenden Daten. Danach muss das Central
 * Directory beginnen und Eintrag für Eintrag dieselben Werte und Offsets tragen.
 */
export function readZipLikeStreamReader(zip: Uint8Array): LocalZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  const entries: LocalZipEntry[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === LOCAL_HEADER) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLength));
    if (flags & 0x8) throw new Error(`${name}: Data Descriptor (Bit 3) gesetzt`);
    if (method !== 0) throw new Error(`${name}: Methode ${method} statt STORE`);
    if (compressedSize !== size) throw new Error(`${name}: Größenfelder widersprechen sich`);
    const start = offset + 30 + nameLength + extraLength;
    const data = zip.subarray(start, start + size);
    if (data.byteLength !== size) throw new Error(`${name}: Daten kürzer als im Local Header`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 im Local Header passt nicht`);
    entries.push({ name, flags, crc, size, offset, data });
    offset = start + size;
  }

  // Ein Stream-Leser ist hier fertig; zur Sicherheit das Central Directory abgleichen.
  let central = offset;
  for (const entry of entries) {
    if (view.getUint32(central, true) !== CENTRAL_HEADER) {
      throw new Error(`${entry.name}: kein Central-Directory-Eintrag an Position ${central}`);
    }
    const nameLength = view.getUint16(central + 28, true);
    const name = decoder.decode(zip.subarray(central + 46, central + 46 + nameLength));
    const matches =
      name === entry.name &&
      view.getUint16(central + 8, true) === entry.flags &&
      view.getUint32(central + 16, true) === entry.crc &&
      view.getUint32(central + 20, true) === entry.size &&
      view.getUint32(central + 24, true) === entry.size &&
      view.getUint32(central + 42, true) === entry.offset;
    if (!matches) throw new Error(`${entry.name}: Central Directory weicht vom Local Header ab`);
    central +=
      46 + nameLength + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  }
  if (view.getUint32(central, true) !== END_OF_CENTRAL_DIRECTORY) {
    throw new Error('Kein End-of-Central-Directory nach dem Central Directory');
  }
  if (
    view.getUint16(central + 10, true) !== entries.length ||
    view.getUint32(central + 16, true) !== offset ||
    central + 22 !== zip.byteLength
  ) {
    throw new Error('End-of-Central-Directory passt nicht zu den Einträgen');
  }
  return entries;
}
