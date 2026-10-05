// Fachkatalog: ACCESS-TENANT-RLS-001
// P-23: Abruf und Prüfung des signierten FIDO-MDS-BLOBs im Worker. Die Fälle
// stammen aus den früheren Web-Tests (webauthn.test.ts), als der Login-Request
// den BLOB noch selbst lud: Streaming-Limit, Signer-Identität, Kettenlänge vor
// jedem Netzzugriff, 30-Sekunden-Zeitlimit bis in die Signatur-/CRL-Prüfung,
// fortlaufende Serie und nextUpdate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  verifyMDSBlob: vi.fn(),
  mdsSignerHostname: 'mds.fidoalliance.org',
  mdsSignerOrganization: 'Fido Alliance, Inc.',
  mdsSignerIntermediateCn: 'GlobalSign GCC R46 EV TLS CA 2025',
  leafIsCa: false,
}));

vi.mock('@simplewebauthn/server/helpers', () => ({ verifyMDSBlob: mocks.verifyMDSBlob }));
vi.mock('@peculiar/x509', () => {
  class BasicConstraintsExtension {
    static kind = 'basic-constraints';
  }
  class ExtendedKeyUsageExtension {
    static kind = 'extended-key-usage';
  }
  class KeyUsagesExtension {
    static kind = 'key-usage';
  }
  class SubjectAlternativeNameExtension {
    static kind = 'subject-alternative-name';
  }
  class X509Certificate {
    readonly marker: string;
    readonly subjectName: { getField: (field: string) => string[] };

    constructor(raw: ArrayBuffer) {
      this.marker = Buffer.from(new Uint8Array(raw)).toString();
      this.subjectName = {
        getField: (field: string) => {
          if (this.marker === 'mds-leaf') {
            if (field === 'CN') return [mocks.mdsSignerHostname];
            if (field === 'O') return [mocks.mdsSignerOrganization];
          }
          if (this.marker === 'mds-intermediate') {
            if (field === 'CN') return [mocks.mdsSignerIntermediateCn];
            if (field === 'O') return ['GlobalSign nv-sa'];
          }
          return [];
        },
      };
    }

    getExtension(type: { kind?: string }) {
      if (this.marker === 'mds-intermediate') {
        if (type.kind === 'key-usage') return { usages: 32 | 64 };
        if (type.kind === 'basic-constraints') return { ca: true, critical: true };
        return null;
      }
      if (this.marker !== 'mds-leaf') return null;
      if (type.kind === 'subject-alternative-name') {
        return { names: { items: [{ type: 'dns', value: mocks.mdsSignerHostname }] } };
      }
      if (type.kind === 'extended-key-usage') return { usages: ['server-auth'] };
      if (type.kind === 'key-usage') return { usages: 1 };
      if (type.kind === 'basic-constraints') return { ca: mocks.leafIsCa };
      return null;
    }
  }
  return {
    BasicConstraintsExtension,
    ExtendedKeyUsage: { serverAuth: 'server-auth' },
    ExtendedKeyUsageExtension,
    KeyUsageFlags: { digitalSignature: 1, keyCertSign: 32, cRLSign: 64 },
    KeyUsagesExtension,
    SubjectAlternativeNameExtension,
    X509Certificate,
  };
});

import { downloadVerifiedFidoMetadata, FIDO_MDS_URL } from '../fido-mds-verify';

function mdsBlob(x5c: string[] = ['mds-leaf', 'mds-intermediate']): string {
  const header = { alg: 'RS256', x5c: x5c.map((marker) => Buffer.from(marker).toString('base64')) };
  return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.payload.signature`;
}

const MDS_BLOB = mdsBlob();
const fido2Entry = {
  aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  metadataStatement: { aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  statusReports: [{ status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-01-01' }],
  timeOfLastStatusChange: '2020-01-01',
};
const u2fEntry = {
  attestationCertificateKeyIdentifiers: ['0123456789abcdef'],
  statusReports: [{ status: 'FIDO_CERTIFIED', effectiveDate: '2020-01-01' }],
  timeOfLastStatusChange: '2020-01-01',
};

function bufferedResponse(blob: string, contentLength: string | null = String(blob.length)) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentLength },
    body: null,
    arrayBuffer: vi.fn(async () => Buffer.from(blob)),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mdsSignerHostname = 'mds.fidoalliance.org';
  mocks.mdsSignerOrganization = 'Fido Alliance, Inc.';
  mocks.mdsSignerIntermediateCn = 'GlobalSign GCC R46 EV TLS CA 2025';
  mocks.leafIsCa = false;
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue(bufferedResponse(MDS_BLOB));
  mocks.verifyMDSBlob.mockResolvedValue({
    statements: [fido2Entry.metadataStatement],
    parsedNextUpdate: new Date('2099-01-01T00:00:00.000Z'),
    payload: { no: 7, nextUpdate: '2099-01-01', entries: [u2fEntry, fido2Entry] },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fido-mds-verify: Abruf und Prüfung des MDS-BLOBs', () => {
  it('lädt ohne Cache, prüft vollständig und liefert BLOB, Serie, nextUpdate und FIDO2-Einträge', async () => {
    await expect(downloadVerifiedFidoMetadata()).resolves.toEqual({
      blob: MDS_BLOB,
      serial: 7,
      nextUpdate: new Date('2099-01-01T00:00:00.000Z'),
      entries: [fido2Entry],
    });
    expect(mocks.fetch).toHaveBeenCalledWith(FIDO_MDS_URL, {
      cache: 'no-store',
      headers: { accept: 'application/jwt' },
      signal: expect.any(AbortSignal),
    });
    expect(mocks.verifyMDSBlob).toHaveBeenCalledWith(MDS_BLOB, {
      signal: expect.any(AbortSignal),
    });
  });

  it('bricht bei einem HTTP-Fehler ohne Signaturprüfung ab', async () => {
    mocks.fetch.mockResolvedValueOnce({ ...bufferedResponse(MDS_BLOB), ok: false, status: 503 });
    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow('FIDO MDS antwortet mit HTTP 503');
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });

  it('weist einen zu großen BLOB schon anhand der angekündigten Länge ab', async () => {
    const response = bufferedResponse(MDS_BLOB, String(20 * 1024 * 1024 + 1));
    mocks.fetch.mockResolvedValueOnce(response);
    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(/Größenbegrenzung/);
    expect(response.arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });

  it('bricht einen Stream ohne Längenangabe beim 20-MiB-Limit ab', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let reads = 0;
    const cancel = vi.fn(async () => undefined);
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: chunk };
          },
          cancel,
          releaseLock: () => undefined,
        }),
      },
    });
    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(/Größenbegrenzung/);
    expect(reads).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });

  it.each([
    [
      'fremder Leaf-Hostname',
      () => (mocks.mdsSignerHostname = 'anderer-global-sign-kunde.example'),
    ],
    ['fremde Organisation', () => (mocks.mdsSignerOrganization = 'Example Corp')],
    ['fremde Intermediate-CA', () => (mocks.mdsSignerIntermediateCn = 'Example Issuing CA')],
    ['Leaf als CA', () => (mocks.leafIsCa = true)],
  ])(
    'bindet den BLOB vor der Signaturprüfung an die FIDO-Signeridentität (%s)',
    async (_case, arrange) => {
      arrange();
      await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(
        'Die Identität des FIDO-MDS-Signers ist nicht freigegeben',
      );
      expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['nur ein Zertifikat', mdsBlob(['mds-leaf'])],
    ['mehr als fünf Zertifikate', mdsBlob(['mds-leaf', 'mds-intermediate', 'a', 'b', 'c', 'd'])],
    [
      'falscher Algorithmus',
      `${Buffer.from(JSON.stringify({ alg: 'none', x5c: [] })).toString('base64url')}.p.s`,
    ],
    ['kein JWT', 'kein-jwt'],
  ])(
    'weist eine unzulässige Zertifikatskette vor jedem Netzzugriff ab (%s)',
    async (_case, blob) => {
      mocks.fetch.mockResolvedValueOnce(bufferedResponse(blob));
      await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(/FIDO-MDS-BLOB besitzt/);
      expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
    },
  );

  it('weist ein nicht kanonisch kodiertes Signer-Zertifikat ab', async () => {
    // 'bWRzLWxlYWY=' wäre kanonisch; 'Z' setzt die verworfenen Füllbits.
    const header = {
      alg: 'RS256',
      x5c: ['bWRzLWxlYWZ=', Buffer.from('mds-intermediate').toString('base64')],
    };
    mocks.fetch.mockResolvedValueOnce(
      bufferedResponse(`${Buffer.from(JSON.stringify(header)).toString('base64url')}.p.s`),
    );
    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(/kein kanonisches Zertifikat/);
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });

  it('setzt einen gestreamten BLOB unterhalb des Limits vollständig zusammen', async () => {
    const bytes = Buffer.from(MDS_BLOB);
    const chunks = [bytes.subarray(0, 10), bytes.subarray(10)];
    const releaseLock = vi.fn();
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            chunks.length > 0
              ? { done: false, value: new Uint8Array(chunks.shift()!) }
              : { done: true, value: undefined },
          cancel: vi.fn(),
          releaseLock,
        }),
      },
    });
    await expect(downloadVerifiedFidoMetadata()).resolves.toMatchObject({
      blob: MDS_BLOB,
      serial: 7,
    });
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(mocks.verifyMDSBlob).toHaveBeenCalledWith(MDS_BLOB, expect.anything());
  });

  it('begrenzt auch eine Antwort ohne Längenangabe und ohne Stream', async () => {
    const response = bufferedResponse(MDS_BLOB, null);
    response.arrayBuffer.mockResolvedValueOnce(Buffer.alloc(20 * 1024 * 1024 + 1));
    mocks.fetch.mockResolvedValueOnce(response);
    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(/Größenbegrenzung/);
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });

  it.each([
    ['leere Antwort', Buffer.alloc(0), 'FIDO-MDS-BLOB ist leer'],
    ['ungültiges UTF-8', Buffer.from([0xff, 0xfe, 0xfd]), /encoded data was not valid/i],
  ])('weist eine unlesbare Antwort ab (%s)', async (_case, body, message) => {
    const response = bufferedResponse(MDS_BLOB, null);
    response.arrayBuffer.mockResolvedValueOnce(body);
    mocks.fetch.mockResolvedValueOnce(response);
    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(message);
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });

  it.each([
    [
      'kein JSON',
      `${Buffer.from('{kein json').toString('base64url')}.p.s`,
      /keinen lesbaren JWT-Header/,
    ],
    [
      'JSON ohne Objekt',
      `${Buffer.from('null').toString('base64url')}.p.s`,
      /keinen strukturierten JWT-Header/,
    ],
    [
      'Zertifikat mit unzulässigen Zeichen',
      `${Buffer.from(JSON.stringify({ alg: 'RS256', x5c: ['@@@', 'AAAA'] })).toString('base64url')}.p.s`,
      /kein gültiges Zertifikat/,
    ],
    [
      'Zertifikat ohne Zeichenkette',
      `${Buffer.from(JSON.stringify({ alg: 'RS256', x5c: [42, 'AAAA'] })).toString('base64url')}.p.s`,
      /kein gültiges Zertifikat/,
    ],
  ])(
    'weist einen unlesbaren geschützten Header vor jedem Netzzugriff ab (%s)',
    async (_case, blob, message) => {
      mocks.fetch.mockResolvedValueOnce(bufferedResponse(blob));
      await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(message);
      expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
    },
  );

  it('reicht einen Fehler der Signatur-, Ketten- oder CRL-Prüfung unverändert weiter', async () => {
    mocks.verifyMDSBlob.mockRejectedValueOnce(new Error('CRL nicht abrufbar'));
    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow('CRL nicht abrufbar');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'verlangt eine gültige fortlaufende BLOB-Nummer (%s)',
    async (no) => {
      mocks.verifyMDSBlob.mockResolvedValueOnce({
        statements: [],
        parsedNextUpdate: new Date('2099-01-01T00:00:00.000Z'),
        payload: { no, nextUpdate: '2099-01-01', entries: [] },
      });
      await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(
        /keine gültige fortlaufende Version/,
      );
    },
  );

  it.each([new Date(0), new Date(Number.NaN)])(
    'verwirft einen abgelaufenen BLOB (%s)',
    async (nextUpdate) => {
      mocks.verifyMDSBlob.mockResolvedValueOnce({
        statements: [],
        parsedNextUpdate: nextUpdate,
        payload: { no: 7, nextUpdate: '1970-01-01', entries: [] },
      });
      await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(
        'Der signierte FIDO-MDS-BLOB ist abgelaufen',
      );
    },
  );

  it('begrenzt eine hängende Signatur-/CRL-Prüfung auf 30 Sekunden und bricht sie ab', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    mocks.verifyMDSBlob.mockImplementationOnce(
      (_blob: string, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise(() => undefined);
      },
    );
    const attempt = downloadVerifiedFidoMetadata();
    const rejected = expect(attempt).rejects.toThrow(
      'Zeitlimit der FIDO-Metadatenprüfung überschritten',
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it('begrenzt auch einen hängenden Abruf auf 30 Sekunden', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementationOnce(() => new Promise(() => undefined));
    const attempt = downloadVerifiedFidoMetadata();
    const rejected = expect(attempt).rejects.toThrow(
      'Zeitlimit der FIDO-Metadatenprüfung überschritten',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });
});
