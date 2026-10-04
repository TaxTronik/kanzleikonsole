// Fachkatalog: DOC-VERSION-IMMUTABILITY-001 (Originalbytes bleiben im gestreamten Archiv unverändert)
// P-03: ZIP-Exporte werden gestreamt statt als Ganzes gepuffert. Jeder Eintrag
// trägt exakte Local Header (CRC-32, Größen, kein Data Descriptor); der
// Export-Slot bleibt bis zum letzten Byte belegt und wird bei Abschluss, Fehler
// und Abbruch genau einmal frei.
import { describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import {
  acquireZipBuildSlot,
  acquireZipStreamSlot,
  bufferedZipMaxTotalBytes,
  buildZip,
  createZipStream,
  ZipBusyError,
  ZipStreamError,
  ZipTooLargeError,
  ZIP_MAX_PARALLEL_STREAMS,
  ZIP_MAX_TOTAL_BYTES,
  type ZipStreamEntry,
} from '../zip';
import { readZipLikeStreamReader } from './zip-format';

const CHUNK = 64 * 1024;
const MiB = 1024 * 1024;
const MAX_ENTRY = 25 * MiB; // wie MAX_UPLOAD_BYTES an den Routen

/** Quelle wie ein S3-Body: erzeugt Bytes erst, wenn sie gelesen wird. */
function source(index: number, size: number, log: string[]): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === 0) log.push(`open ${index}`);
        if (offset >= size) {
          log.push(`end ${index}`);
          controller.close();
          return;
        }
        const length = Math.min(CHUNK, size - offset);
        controller.enqueue(new Uint8Array(length).fill(index + 1));
        offset += length;
      },
      cancel() {
        log.push(`cancel ${index}`);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Liefert einen Chunk und hängt dann (langsames S3): der Writer puffert noch. */
function stalling(index: number, log: string[]): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) return new Promise<void>(() => undefined);
        sent = true;
        log.push(`open ${index}`);
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        log.push(`cancel ${index}`);
      },
    },
    { highWaterMark: 0 },
  );
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function join(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Ein freier Slot wird sofort vergeben; ein belegter würde bis zu 10 s pollen. */
function acquireImmediately(): Promise<() => void> {
  return Promise.race([
    acquireZipStreamSlot(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Export-Slot ist noch belegt')), 50);
    }),
  ]);
}

async function expectAllStreamSlotsFree(): Promise<void> {
  const releases = [];
  for (let slot = 0; slot < ZIP_MAX_PARALLEL_STREAMS; slot += 1) {
    releases.push(await acquireImmediately());
  }
  releases.forEach((release) => release());
}

describe('P-03: createZipStream', () => {
  it('streamt ein großes Mehrdatei-Archiv mit exakten Local Headern, ohne Gesamtpuffer', async () => {
    const files = 24;
    const size = 2 * MiB + 123; // nicht an Chunkgrenzen ausgerichtet
    const log: string[] = [];
    async function* entries(): AsyncGenerator<ZipStreamEntry> {
      for (let index = 0; index < files; index += 1) {
        log.push(`request ${index}`);
        yield {
          name: `Belege/datei-${index}.pdf`,
          data: source(index, size, log),
          modifiedAt: new Date(2026, 8, 7, 9, 0, 0),
        };
      }
      yield { name: 'index.csv', data: Buffer.from('﻿Lfd-Nr;Titel\r\n0001;Büro', 'utf8') };
      yield { name: 'Übersicht/leer.txt', data: new Uint8Array(0) };
    }
    const concat = vi.spyOn(Buffer, 'concat');
    const onSettled = vi.fn();

    const chunks = await readAll(
      createZipStream(entries(), { maxEntryBytes: MAX_ENTRY, onSettled }),
    );

    // Kein Gesamtpuffer: weder Buffer.concat noch Chunks über der Quell-Chunkgröße.
    expect(concat).not.toHaveBeenCalled();
    concat.mockRestore();
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(CHUNK);
    // Der nächste Eintrag (= nächstes S3-Objekt) wird erst nach dem vorigen angefordert.
    expect(log).toEqual(
      Array.from({ length: files }, (_, index) => [
        `request ${index}`,
        `open ${index}`,
        `end ${index}`,
      ]).flat(),
    );
    expect(onSettled).toHaveBeenCalledExactlyOnceWith('completed', undefined);

    const zip = join(chunks);
    const names = [
      ...Array.from({ length: files }, (_, index) => `Belege/datei-${index}.pdf`),
      'index.csv',
      'Übersicht/leer.txt',
    ];
    // Wie ein Stream-Leser (ZipInputStream): nur Local Header, kein Bit 3.
    const local = readZipLikeStreamReader(zip);
    expect(local.map((entry) => entry.name)).toEqual(names);
    for (const entry of local) {
      expect(entry.flags & 0x8).toBe(0);
      expect(entry.flags & 0x800).toBe(0x800); // UTF-8-Namen wie buildZip
    }
    for (let index = 0; index < files; index += 1) {
      expect(local[index]!.size).toBe(size);
      expect(local[index]!.data.every((byte) => byte === index + 1)).toBe(true);
    }
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(local[files]!.data)).toBe(
      '﻿Lfd-Nr;Titel\r\n0001;Büro',
    );
    expect(local[files + 1]!.size).toBe(0);
    // Gegenprobe mit einem Central-Directory-Leser.
    expect(Object.keys(unzipSync(zip))).toEqual(names);
  });

  it('schreibt dasselbe Archiv wie buildZip (gleiches Format, exakte Header)', async () => {
    const modifiedAt = new Date(2026, 8, 7, 9, 0, 0);
    const entries = [
      { name: 'a.pdf', data: Buffer.from('erster Beleg'), modifiedAt },
      { name: 'Ordner/Büro.txt', data: Buffer.from('zweiter Beleg'), modifiedAt },
      { name: 'leer.bin', data: Buffer.alloc(0), modifiedAt },
    ];
    const streamed = join(
      await readAll(
        createZipStream(
          [
            entries[0]!,
            // Eine Quelle als Stream, zwei als fertige Bytes: gleiches Ergebnis.
            {
              name: entries[1]!.name,
              modifiedAt,
              data: new Response(new Uint8Array(entries[1]!.data)).body!,
            },
            entries[2]!,
          ],
          { maxEntryBytes: MAX_ENTRY },
        ),
      ),
    );
    expect(Buffer.from(streamed).equals(buildZip(entries))).toBe(true);
  });

  it('puffert höchstens einen Eintrag: die nächste Quelle erst, wenn der vorige abgenommen ist', async () => {
    const log: string[] = [];
    const reader = createZipStream(
      [
        { name: 'a.bin', data: source(0, 4 * CHUNK, log) },
        { name: 'b.bin', data: source(1, 4 * CHUNK, log) },
      ],
      { maxEntryBytes: MAX_ENTRY },
    ).getReader();

    // Header + 3 von 4 Datenchunks von a.bin: a.bin liegt vollständig vor, b.bin ist zu.
    for (let read = 0; read < 4; read += 1) await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(['open 0', 'end 0']);

    await reader.read(); // letzter Chunk von a.bin
    await vi.waitFor(() => expect(log).toEqual(['open 0', 'end 0', 'open 1', 'end 1']));
    await reader.cancel();
  });

  it('hält den Export-Slot bis zum letzten Byte und gibt ihn genau einmal frei', async () => {
    const release = vi.fn(await acquireZipStreamSlot());
    const log: string[] = [];
    const reader = createZipStream([{ name: 'a.bin', data: source(0, 3 * CHUNK, log) }], {
      maxEntryBytes: MAX_ENTRY,
      onSettled: release,
    }).getReader();

    await reader.read();
    expect(release).not.toHaveBeenCalled();
    while (!(await reader.read()).done) {
      // Rest abnehmen
    }

    expect(release).toHaveBeenCalledExactlyOnceWith('completed', undefined);
    await expectAllStreamSlotsFree();
  });

  it('Abbruch durch den Client: Slot frei, gerade gelesene Quelle geschlossen, Generator beendet', async () => {
    const release = vi.fn(await acquireZipStreamSlot());
    const log: string[] = [];
    let generatorClosed = false;
    async function* entries(): AsyncGenerator<ZipStreamEntry> {
      try {
        yield { name: 'a.bin', data: source(0, CHUNK, log) };
        yield { name: 'b.bin', data: stalling(1, log) };
        yield { name: 'c.bin', data: source(2, CHUNK, log) };
      } finally {
        generatorClosed = true;
      }
    }
    const reader = createZipStream(entries(), {
      maxEntryBytes: MAX_ENTRY,
      onSettled: release,
    }).getReader();
    await reader.read(); // Header a.bin
    await reader.read(); // Daten a.bin; danach puffert der Writer b.bin (hängt)
    await vi.waitFor(() => expect(log).toContain('open 1'));

    await reader.cancel(new Error('Client weg'));

    expect(release).toHaveBeenCalledExactlyOnceWith('cancelled', expect.any(Error));
    await vi.waitFor(() => expect(log).toContain('cancel 1'));
    await vi.waitFor(() => expect(generatorClosed).toBe(true));
    expect(log).not.toContain('open 2');
    await expectAllStreamSlotsFree();
  });

  it('Client-Disconnect per AbortSignal: Slot frei, Quelle geschlossen, Leser erhält den Abbruch', async () => {
    const controller = new AbortController();
    const release = vi.fn(await acquireZipStreamSlot());
    const log: string[] = [];
    const reader = createZipStream([{ name: 'a.bin', data: stalling(0, log) }], {
      maxEntryBytes: MAX_ENTRY,
      signal: controller.signal,
      onSettled: release,
    }).getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(log).toContain('open 0'));

    controller.abort(new Error('Verbindung getrennt'));

    expect(release).toHaveBeenCalledExactlyOnceWith('cancelled', expect.any(Error));
    await expect(pendingRead).rejects.toThrow('Verbindung getrennt');
    await vi.waitFor(() => expect(log).toContain('cancel 0'));
    await expectAllStreamSlotsFree();
  });

  it('bereits abgebrochenes Signal: keine Quelle geöffnet, Slot sofort frei', async () => {
    const release = vi.fn(await acquireZipStreamSlot());
    const log: string[] = [];
    const stream = createZipStream([{ name: 'a.bin', data: source(0, CHUNK, log) }], {
      maxEntryBytes: MAX_ENTRY,
      signal: AbortSignal.abort(new Error('schon weg')),
      onSettled: release,
    });

    await expect(readAll(stream)).rejects.toThrow('schon weg');
    expect(release).toHaveBeenCalledExactlyOnceWith('cancelled', expect.any(Error));
    expect(log).toEqual([]);
    await expectAllStreamSlotsFree();
  });

  it('Quellfehler: Abbruch statt eines still unvollständigen Archivs', async () => {
    const release = vi.fn(await acquireZipStreamSlot());
    let sent = false;
    const failing = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) return controller.error(new Error('S3-Verbindung zurückgesetzt'));
          sent = true;
          controller.enqueue(new Uint8Array(10));
        },
      },
      { highWaterMark: 0 },
    );
    const stream = createZipStream(
      [
        { name: 'a.bin', data: failing },
        { name: 'b.txt', data: new Uint8Array(3) },
      ],
      { maxEntryBytes: MAX_ENTRY, onSettled: release },
    );

    await expect(readAll(stream)).rejects.toThrow('S3-Verbindung zurückgesetzt');
    expect(release).toHaveBeenCalledExactlyOnceWith(
      'failed',
      expect.objectContaining({ message: 'S3-Verbindung zurückgesetzt' }),
    );
    await expectAllStreamSlotsFree();
  });

  it('onReadError: Lesefehler oder Übergröße lassen nur diesen Eintrag aus', async () => {
    const log: string[] = [];
    const skipped: string[] = [];
    let sent = false;
    const failing = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) return controller.error(new Error('S3-Verbindung zurückgesetzt'));
          sent = true;
          controller.enqueue(new Uint8Array(10));
        },
      },
      { highWaterMark: 0 },
    );
    const onSettled = vi.fn();
    const chunks = await readAll(
      createZipStream(
        [
          {
            name: 'kaputt.bin',
            data: failing,
            onReadError: (error) => skipped.push(`kaputt: ${(error as Error).message}`),
          },
          {
            name: 'zu-gross.bin',
            data: source(1, 3 * CHUNK, log),
            onReadError: (error) => skipped.push(`zu-gross: ${(error as Error).name}`),
          },
          { name: 'ok.bin', data: source(2, CHUNK, log) },
        ],
        { maxEntryBytes: 2 * CHUNK, maxSourceBytes: 3 * CHUNK, onSettled },
      ),
    );

    expect(skipped).toEqual(['kaputt: S3-Verbindung zurückgesetzt', 'zu-gross: ZipStreamError']);
    expect(log).toContain('cancel 1');
    // Ausgelassene Bytes zählen nicht gegen die Summengrenze (3 × CHUNK).
    expect(onSettled).toHaveBeenCalledExactlyOnceWith('completed', undefined);
    expect(readZipLikeStreamReader(join(chunks)).map((entry) => entry.name)).toEqual(['ok.bin']);
  });

  it.each([
    ['je Quelle (wie fetchObjectBytes)', { maxEntryBytes: 2 * CHUNK }, ZipStreamError],
    [
      'über alle Quellen (P-2-Backstop)',
      { maxEntryBytes: MAX_ENTRY, maxSourceBytes: 3 * CHUNK },
      ZipTooLargeError,
    ],
  ] as const)('Backstop %s bricht den Stream ab', async (_label, limits, ErrorType) => {
    const log: string[] = [];
    const onSettled = vi.fn();
    const stream = createZipStream(
      [
        { name: 'a.bin', data: source(0, 2 * CHUNK, log) },
        { name: 'b.bin', data: source(1, 2 * CHUNK + 1, log) },
      ],
      { ...limits, onSettled },
    );

    await expect(readAll(stream)).rejects.toBeInstanceOf(ErrorType);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith('failed', expect.any(ErrorType));
    expect(log).toContain('cancel 1');
  });

  it('die Summengrenze bricht auch mit onReadError ab (früher 413)', async () => {
    const log: string[] = [];
    const onReadError = vi.fn();
    const stream = createZipStream(
      [
        { name: 'a.bin', data: source(0, 2 * CHUNK, log), onReadError },
        { name: 'b.bin', data: source(1, 2 * CHUNK, log), onReadError },
      ],
      { maxEntryBytes: MAX_ENTRY, maxSourceBytes: 3 * CHUNK },
    );

    await expect(readAll(stream)).rejects.toBeInstanceOf(ZipTooLargeError);
    expect(onReadError).not.toHaveBeenCalled();
  });

  it('hängender Client: Leerlauf-Abbruch gibt den Slot frei', async () => {
    vi.useFakeTimers();
    try {
      const onSettled = vi.fn();
      const log: string[] = [];
      const reader = createZipStream([{ name: 'a.bin', data: source(0, 4 * CHUNK, log) }], {
        maxEntryBytes: MAX_ENTRY,
        onSettled,
        idleTimeoutMs: 1_000,
      }).getReader();
      await reader.read();

      await vi.advanceTimersByTimeAsync(999);
      expect(onSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(onSettled).toHaveBeenCalledExactlyOnceWith('failed', expect.any(ZipStreamError));
      await expect(reader.read()).rejects.toBeInstanceOf(ZipStreamError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('P-03: Export-Slots', () => {
  it('eigene Pools: 4 gestreamte Exporte neben 2 gepufferten Builds, dann ZipBusyError', async () => {
    vi.useFakeTimers();
    const releases: (() => void)[] = [];
    try {
      for (let slot = 0; slot < ZIP_MAX_PARALLEL_STREAMS; slot += 1) {
        releases.push(await acquireZipStreamSlot());
      }
      // Gepufferte Builds bleiben beim bisherigen Limit von 2, unabhängig von Streams.
      releases.push(await acquireZipBuildSlot(), await acquireZipBuildSlot());

      const extraStream = expect(acquireZipStreamSlot()).rejects.toBeInstanceOf(ZipBusyError);
      const extraBuild = expect(acquireZipBuildSlot()).rejects.toBeInstanceOf(ZipBusyError);
      await vi.advanceTimersByTimeAsync(10_000);
      await extraStream;
      await extraBuild;
    } finally {
      releases.forEach((release) => release());
      vi.useRealTimers();
    }
    expect(ZIP_MAX_PARALLEL_STREAMS).toBe(4);
  });
});

describe('P-03: Grenze für gepufferte Builds aus dem Speicherlimit', () => {
  it('leitet die Grenze aus dem Limit ab und bleibt unter ZIP_MAX_TOTAL_BYTES', () => {
    expect(bufferedZipMaxTotalBytes(2 * 1024 * MiB)).toBe(256 * MiB); // APP_MEM_LIMIT-Default
    expect(bufferedZipMaxTotalBytes(512 * MiB)).toBe(64 * MiB);
    expect(bufferedZipMaxTotalBytes(64 * 1024 * MiB)).toBe(ZIP_MAX_TOTAL_BYTES);
  });

  it('buildZip folgt dem Container-Limit (process.constrainedMemory)', () => {
    const constrained = vi.spyOn(process, 'constrainedMemory').mockReturnValue(64 * MiB);
    try {
      expect(() => buildZip([{ name: 'a.bin', data: Buffer.alloc(9 * MiB) }])).toThrow(
        expect.objectContaining({ name: 'ZipTooLargeError', limitBytes: 8 * MiB }),
      );
      expect(buildZip([{ name: 'a.bin', data: Buffer.alloc(MiB) }]).byteLength).toBeGreaterThan(
        MiB,
      );
    } finally {
      constrained.mockRestore();
    }
  });
});
