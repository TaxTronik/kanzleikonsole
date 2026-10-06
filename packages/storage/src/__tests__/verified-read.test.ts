// =============================================================================
// R-05: Ein Leseweg für gespeicherte Objekte — fetchVerifiedObjectBytes,
// streamVerifiedObject, fetchObjectHead (Range) und bytesResponseBody.
// Jede bekannte Erwartung (Größe, SHA-256) wird geprüft, das Größenlimit gilt
// auf allen Wegen, und Antworten entstehen ohne weitere Pufferkopie.
// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../client', () => ({
  s3: { send: h.send },
  classificationToTier: vi.fn(() => 'GOBD'),
  getBucketForTier: vi.fn((tier: string) => `bucket-${tier.toLowerCase()}`),
}));

import {
  bytesResponseBody,
  fetchObjectBytes,
  fetchObjectHead,
  fetchVerifiedObjectBytes,
  MAX_UPLOAD_BYTES,
  StoredObjectError,
  streamVerifiedObject,
} from '../service';

const REF = { bucket: 'gobd', key: 'tenant/doc.pdf', versionId: 'v-1' };
const CONTENT = Buffer.from('%PDF-1.7 synthetic document bytes');
const SHA = createHash('sha256').update(CONTENT).digest();

function storedObject(
  chunks: readonly Buffer[],
  options: { contentLength?: number | null; contentType?: string } = {},
) {
  const body = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  const destroy = vi.spyOn(body, 'destroy');
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  h.send.mockResolvedValueOnce({
    Body: body,
    ContentLength:
      options.contentLength === undefined ? total : (options.contentLength ?? undefined),
    ContentType: options.contentType ?? 'application/pdf',
  });
  return { body, destroy };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

function expectReason(reason: string) {
  return expect.objectContaining({ name: 'StoredObjectError', reason });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchVerifiedObjectBytes', () => {
  it('liefert die gebundene Fassung nach Größen- und SHA-256-Prüfung', async () => {
    storedObject([CONTENT.subarray(0, 5), CONTENT.subarray(5, 20), CONTENT.subarray(20)]);

    const bytes = await fetchVerifiedObjectBytes(REF, {
      sizeBytes: BigInt(CONTENT.length),
      sha256: SHA.toString('hex'),
    });

    expect(bytes).toEqual(CONTENT);
    expect(bytes.buffer.byteLength).toBe(CONTENT.length);
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'gobd',
      Key: 'tenant/doc.pdf',
      VersionId: 'v-1',
    });
  });

  it('akzeptiert den Hash auch als Rohbytes', async () => {
    storedObject([CONTENT]);
    await expect(fetchVerifiedObjectBytes(REF, { sha256: SHA })).resolves.toEqual(CONTENT);
  });

  it('weist einen abweichenden Hash als Integritätsverletzung zurück', async () => {
    storedObject([Buffer.from('%PDF-1.7 manipulierte Bytes!!!!!!')]);

    const error = await fetchVerifiedObjectBytes(REF, { sha256: SHA.toString('hex') }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StoredObjectError);
    expect(error).toMatchObject({ reason: 'HASH_MISMATCH', integrityViolation: true });
  });

  it('prüft die Hex-Prüfsumme exakt', async () => {
    storedObject([CONTENT]);
    await expect(
      fetchVerifiedObjectBytes(REF, { sha256: SHA.toString('hex').toUpperCase() }),
    ).rejects.toEqual(expectReason('HASH_MISMATCH'));
  });

  it('erkennt eine abweichende ContentLength, ohne den Body zu lesen', async () => {
    const { destroy } = storedObject([CONTENT], { contentLength: CONTENT.length + 1 });
    await expect(fetchVerifiedObjectBytes(REF, { sizeBytes: CONTENT.length })).rejects.toEqual(
      expectReason('LENGTH_MISMATCH'),
    );
    expect(destroy).toHaveBeenCalled();
  });

  it('bricht beim ersten überzähligen Byte ab und meldet fehlende Bytes am Ende', async () => {
    storedObject([CONTENT, Buffer.from('mehr')], { contentLength: null });
    await expect(fetchVerifiedObjectBytes(REF, { sizeBytes: CONTENT.length })).rejects.toEqual(
      expectReason('OVERFLOW'),
    );

    storedObject([CONTENT.subarray(0, 10)], { contentLength: null });
    await expect(fetchVerifiedObjectBytes(REF, { sizeBytes: CONTENT.length })).rejects.toEqual(
      expectReason('SIZE_MISMATCH'),
    );
  });

  it('erzwingt das Größenlimit vor, bei und während des Lesens', async () => {
    await expect(
      fetchVerifiedObjectBytes(REF, { sizeBytes: MAX_UPLOAD_BYTES + 1 }),
    ).rejects.toEqual(expectReason('TOO_LARGE'));
    expect(h.send).not.toHaveBeenCalled();

    const announced = storedObject([CONTENT], { contentLength: 100 });
    await expect(fetchVerifiedObjectBytes(REF, {}, { maxBytes: 99 })).rejects.toThrow(
      'TOO_LARGE: Objekt (100 B) überschreitet das Limit.',
    );
    expect(announced.destroy).toHaveBeenCalled();

    storedObject([CONTENT, CONTENT], { contentLength: null });
    await expect(fetchVerifiedObjectBytes(REF, {}, { maxBytes: CONTENT.length })).rejects.toThrow(
      'TOO_LARGE: Objekt überschreitet das Limit (Streaming).',
    );
  });

  it('meldet einen fehlenden Body und eine unlesbare Erwartung fail-closed', async () => {
    h.send.mockResolvedValueOnce({ Body: undefined });
    await expect(fetchVerifiedObjectBytes(REF)).rejects.toEqual(expectReason('MISSING_BODY'));
    await expect(fetchVerifiedObjectBytes(REF, { sizeBytes: -1 })).rejects.toEqual(
      expectReason('SIZE_MISMATCH'),
    );
  });

  it('fällt bei ungültiger gebundener Version nie auf den veränderlichen Key zurück', async () => {
    await expect(fetchVerifiedObjectBytes({ ...REF, versionId: 'null' })).rejects.toThrow(
      'STORAGE_VERSION_ID_INVALID',
    );
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('fetchObjectBytes', () => {
  it('liest ungebundene Bytes über denselben Weg mit Limit', async () => {
    storedObject([CONTENT.subarray(0, 4), CONTENT.subarray(4)]);
    await expect(fetchObjectBytes('general', 'raw.json')).resolves.toEqual(CONTENT);
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'general',
      Key: 'raw.json',
    });
  });
});

describe('streamVerifiedObject', () => {
  it('streamt die Bytes mit Länge und Typ der gespeicherten Fassung', async () => {
    storedObject([CONTENT.subarray(0, 7), CONTENT.subarray(7)]);

    const object = await streamVerifiedObject(REF, { sizeBytes: CONTENT.length, sha256: SHA });

    expect(object.contentLength).toBe(CONTENT.length);
    expect(object.contentType).toBe('application/pdf');
    await expect(readAll(object.body)).resolves.toEqual(CONTENT);
  });

  it('lässt den Stream bei abweichendem Hash fehlschlagen statt ihn vollständig zu liefern', async () => {
    storedObject([Buffer.from('%PDF-1.7 manipulierte Bytes!!!!!!')]);

    const object = await streamVerifiedObject(REF, { sha256: SHA.toString('hex') });

    await expect(readAll(object.body)).rejects.toEqual(expectReason('HASH_MISMATCH'));
  });

  it('gibt das letzte Stück erst nach bestandener Prüfung frei', async () => {
    // Gleiche Länge, letztes Byte verändert: nur der Hash am Ende deckt es auf.
    const tampered = Buffer.from(CONTENT);
    const last = tampered.length - 1;
    tampered.writeUInt8(tampered.readUInt8(last) ^ 0xff, last);
    storedObject([tampered.subarray(0, 10), tampered.subarray(10, 20), tampered.subarray(20)]);

    const object = await streamVerifiedObject(REF, { sizeBytes: CONTENT.length, sha256: SHA });
    const reader = object.body.getReader();
    const delivered: Buffer[] = [];
    const failure = await (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        delivered.push(Buffer.from(value));
      }
    })().catch((caught: unknown) => caught);

    expect(failure).toEqual(expectReason('HASH_MISMATCH'));
    // Ohne das letzte Stück bleibt die Antwort für den Client unvollständig (Content-
    // Length bzw. fehlender Chunk-Abschluss) — nie ein vollständiger falscher Download.
    expect(Buffer.concat(delivered)).toEqual(tampered.subarray(0, 20));
  });

  it('bricht bei überzähligen Bytes ab und schließt die Quelle', async () => {
    const { destroy } = storedObject([CONTENT, Buffer.from('mehr')], { contentLength: null });

    const object = await streamVerifiedObject(REF, { sizeBytes: CONTENT.length });

    await expect(readAll(object.body)).rejects.toEqual(expectReason('OVERFLOW'));
    await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
  });

  it('prüft Erwartung und Limit vor dem ersten Byte', async () => {
    storedObject([CONTENT], { contentLength: CONTENT.length + 1 });
    await expect(streamVerifiedObject(REF, { sizeBytes: CONTENT.length })).rejects.toEqual(
      expectReason('LENGTH_MISMATCH'),
    );
  });
});

describe('fetchObjectHead', () => {
  it('liest die Kopfbytes der gebundenen Fassung per Range-Request', async () => {
    storedObject([CONTENT.subarray(0, 16)], { contentLength: 16 });

    const head = await fetchObjectHead(REF, 16);

    expect(head).toEqual(CONTENT.subarray(0, 16));
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'gobd',
      Key: 'tenant/doc.pdf',
      VersionId: 'v-1',
      Range: 'bytes=0-15',
    });
  });

  it('liest bei einem Store ohne Range-Unterstützung nicht über die Kopfbytes hinaus', async () => {
    const { destroy } = storedObject([
      Buffer.alloc(600, 1),
      Buffer.alloc(600, 2),
      Buffer.alloc(600, 3),
    ]);

    const head = await fetchObjectHead(REF);

    expect(head.length).toBe(1024);
    expect(head.subarray(0, 600)).toEqual(Buffer.alloc(600, 1));
    expect(head.subarray(600)).toEqual(Buffer.alloc(424, 2));
    expect(destroy).toHaveBeenCalled();
  });

  it('liefert für ein leeres Objekt (HTTP 416) keine Kopfbytes', async () => {
    h.send.mockRejectedValueOnce(
      Object.assign(new Error('InvalidRange'), {
        name: 'InvalidRange',
        $metadata: { httpStatusCode: 416 },
      }),
    );
    await expect(fetchObjectHead(REF)).resolves.toEqual(Buffer.alloc(0));
  });

  it.each([0, -1, 1.5])('weist die ungültige Länge %s ohne S3-Abruf zurück', async (length) => {
    await expect(fetchObjectHead(REF, length)).rejects.toBeInstanceOf(RangeError);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('bytesResponseBody', () => {
  it('übergibt den Puffer ohne Kopie als einzigen Chunk', async () => {
    const bytes = Buffer.from('antwort');
    const response = new Response(bytesResponseBody(bytes));
    // Ohne Kopie wird eine spätere Änderung des Puffers sichtbar —
    // new Response(new Uint8Array(bytes)) hätte zweimal kopiert.
    bytes[0] = 0x41;

    await expect(response.arrayBuffer().then((b) => Buffer.from(b).toString())).resolves.toBe(
      'Antwort',
    );
  });
});
