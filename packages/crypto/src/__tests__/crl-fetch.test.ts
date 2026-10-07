// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// T-02 (SSRF): CRL-Abrufe erreichen nur öffentliche Adressen. Belegt werden
// die Adressklassen (IPv4, IPv6, gemappte, kompatible und NAT64-Formen), die
// einmalige Auflösung mit geprüftem Ergebnis, die URL-Regeln, die gepinnte
// Verbindung gegen einen lokalen Server (der Hostname selbst ist nicht
// auflösbar), Redirects und Abbruch sowie der Fail-close der Pfadprüfung mit
// derselben Fehlerkette wie bei einer nicht erreichbaren CRL.
// =============================================================================

import type { webcrypto } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  CRLDistributionPointsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
  type X509Certificate,
} from '@peculiar/x509';
import { validateCertificatePath } from '../certificate-path';
import {
  CrlTargetRefusedError,
  fetchCrl,
  isPermittedCrlAddress,
  requestPinnedCrl,
  resolveCrlAddresses,
} from '../crl-fetch';

type CryptoKeyPair = webcrypto.CryptoKeyPair;

const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Lokaler Server auf 127.0.0.1; zählt die eingegangenen Anfragen. */
async function listen(
  handler: http.RequestListener,
): Promise<{ port: number; requests: http.IncomingMessage[] }> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

const LOCAL = [{ address: '127.0.0.1', family: 4 }] as const;

describe('isPermittedCrlAddress', () => {
  it.each([
    ['0.0.0.0', 'IPv4 unspezifiziert'],
    ['0.1.2.3', '0.0.0.0/8'],
    ['127.0.0.1', 'Loopback'],
    ['127.255.255.254', 'Loopback, ganzes /8'],
    ['10.0.0.1', 'privat 10/8 (RFC 1918)'],
    ['172.16.0.1', 'privat 172.16/12, unten'],
    ['172.31.255.255', 'privat 172.16/12, oben'],
    ['192.168.1.10', 'privat 192.168/16'],
    ['169.254.169.254', 'Link-local, Cloud-Metadaten'],
    ['100.64.0.1', 'CGNAT, unten'],
    ['100.127.255.255', 'CGNAT, oben'],
    ['224.0.0.1', 'Multicast'],
    ['239.255.255.250', 'Multicast, oben'],
    ['255.255.255.255', 'Broadcast'],
    ['240.0.0.1', 'reserviert'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['198.18.0.1', 'Benchmarking'],
    ['192.0.0.8', 'IETF-Protokollzuweisungen'],
    ['::', 'IPv6 unspezifiziert'],
    ['::1', 'IPv6-Loopback'],
    ['fc00::1', 'Unique Local (RFC 4193)'],
    ['fd12:3456:789a::1', 'Unique Local (RFC 4193)'],
    ['fe80::1', 'IPv6 Link-local'],
    ['febf:ffff::1', 'IPv6 Link-local, oben'],
    ['fec0::1', 'Site-local (veraltet)'],
    ['ff02::1', 'IPv6-Multicast'],
    ['ff0e::101', 'IPv6-Multicast, global'],
    ['::ffff:127.0.0.1', 'IPv4-gemappt: Loopback'],
    ['::ffff:7f00:1', 'IPv4-gemappt: Loopback, hexadezimal'],
    ['::ffff:10.1.2.3', 'IPv4-gemappt: privat'],
    ['::ffff:a9fe:a9fe', 'IPv4-gemappt: Link-local, hexadezimal'],
    ['::ffff:100.64.0.1', 'IPv4-gemappt: CGNAT'],
    ['::ffff:0.0.0.0', 'IPv4-gemappt: unspezifiziert'],
    ['::ffff:224.0.0.1', 'IPv4-gemappt: Multicast'],
    ['::127.0.0.1', 'IPv4-kompatibel (veraltet)'],
    ['::8.8.8.8', 'IPv4-kompatibel, auch mit öffentlicher Adresse'],
    ['64:ff9b::7f00:1', 'NAT64 auf Loopback'],
    ['64:ff9b::192.168.0.1', 'NAT64 auf privat'],
    ['64:ff9b:1::a00:1', 'NAT64 lokal (RFC 8215)'],
    ['100::1', 'Discard-Only'],
    ['2001::1', 'Teredo (2001::/23)'],
    ['2001:2::1', 'Benchmarking (2001::/23)'],
    ['2001:db8::1', 'Dokumentation'],
    ['2002:7f00:1::1', '6to4'],
    ['3fff::1', 'Dokumentation (RFC 9637)'],
    ['fe80::1%eth0', 'Zonen-ID'],
    ['1.2.3', 'keine IP-Adresse'],
    ['localhost', 'Hostname'],
    ['', 'leer'],
  ])('%s ist gesperrt (%s)', (address) => {
    expect(isPermittedCrlAddress(address)).toBe(false);
  });

  it.each([
    ['8.8.8.8', 'öffentlich'],
    ['1.1.1.1', 'öffentlich'],
    ['9.255.255.255', 'direkt unter 10/8'],
    ['11.0.0.1', 'direkt über 10/8'],
    ['100.63.255.255', 'direkt unter CGNAT'],
    ['100.128.0.1', 'direkt über CGNAT'],
    ['126.255.255.255', 'direkt unter 127/8'],
    ['169.253.255.255', 'direkt unter 169.254/16'],
    ['172.15.255.255', 'direkt unter 172.16/12'],
    ['172.32.0.1', 'direkt über 172.16/12'],
    ['192.167.255.255', 'direkt unter 192.168/16'],
    ['223.255.255.255', 'direkt unter Multicast'],
    ['2606:4700:4700::1111', 'öffentlich IPv6'],
    ['2a00:1450:4001:82a::200e', 'öffentlich IPv6'],
    ['2001:4860:4860::8888', '2001::/16 außerhalb von 2001::/23'],
    ['2001:200::1', 'direkt über 2001::/23'],
    ['3fff:1000::1', 'direkt über 3fff::/20'],
    ['::ffff:8.8.8.8', 'IPv4-gemappt: öffentlich'],
    ['64:ff9b::808:808', 'NAT64 auf öffentlich'],
  ])('%s ist erlaubt (%s)', (address) => {
    expect(isPermittedCrlAddress(address)).toBe(true);
  });
});

describe('resolveCrlAddresses', () => {
  it('prüft IP-Literale ohne DNS-Auflösung', async () => {
    const resolve = vi.fn();
    await expect(resolveCrlAddresses('8.8.8.8', resolve)).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
    ]);
    await expect(resolveCrlAddresses('2606:4700:4700::1111', resolve)).resolves.toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    for (const literal of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:7f00:1']) {
      await expect(resolveCrlAddresses(literal, resolve)).rejects.toBeInstanceOf(
        CrlTargetRefusedError,
      );
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('löst einen Hostnamen genau einmal auf und liefert nur öffentliche Antworten', async () => {
    const answer = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    const resolve = vi.fn(async () => answer);
    await expect(resolveCrlAddresses('crl.example.com', resolve)).resolves.toEqual(answer);
    expect(resolve).toHaveBeenCalledExactlyOnceWith('crl.example.com');
  });

  it.each([
    [
      'eine private unter öffentlichen Adressen',
      [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    ],
    ['Loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['IPv6-Loopback', [{ address: '::1', family: 6 }]],
    ['IPv4-gemappte Loopback-Adresse', [{ address: '::ffff:127.0.0.1', family: 6 }]],
    ['Link-local mit Zonen-ID', [{ address: 'fe80::1%eth0', family: 6 }]],
    ['keine Adresse', []],
  ])('weist ab bei %s', async (_case, answer) => {
    await expect(resolveCrlAddresses('crl.example.com', async () => answer)).rejects.toThrow(
      CrlTargetRefusedError,
    );
  });

  it('weist ab, wenn die Auflösung scheitert, und behält die Ursache', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND crl.example.test'), {
      code: 'ENOTFOUND',
    });
    await expect(
      resolveCrlAddresses('crl.example.test', () => Promise.reject(failure)),
    ).rejects.toMatchObject({
      name: 'CrlTargetRefusedError',
      message: 'CRL host could not be resolved',
      cause: failure,
    });
  });

  it('bricht eine hängende Auflösung mit dem Abbruchsignal ab', async () => {
    const controller = new AbortController();
    const pending = resolveCrlAddresses(
      'crl.example.com',
      () => new Promise(() => undefined),
      controller.signal,
    );
    controller.abort(new Error('Zeitlimit erreicht'));
    await expect(pending).rejects.toMatchObject({
      name: 'CrlTargetRefusedError',
      cause: expect.objectContaining({ message: 'Zeitlimit erreicht' }),
    });
  });
});

describe('fetchCrl: Abweisung vor jedem Verbindungsaufbau', () => {
  it.each([
    'ftp://crl.example.com/root.crl',
    'file:///etc/passwd',
    'ldap://crl.example.com/cn=root',
    'http://nutzer@crl.example.com/root.crl',
    'http://nutzer:x@crl.example.com/root.crl',
    'http://crl.example.com:8080/root.crl',
    'https://crl.example.com:8443/root.crl',
    'keine-url',
  ])('URL %s', async (url) => {
    const resolve = vi.fn();
    const requests = [vi.spyOn(http, 'request'), vi.spyOn(https, 'request')];
    await expect(fetchCrl(url, { redirect: 'error' }, resolve)).rejects.toBeInstanceOf(
      CrlTargetRefusedError,
    );
    expect(resolve).not.toHaveBeenCalled();
    for (const request of requests) expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['Loopback-Literal', 'http://127.0.0.1/root.crl', undefined],
    ['Cloud-Metadaten', 'http://169.254.169.254/latest/meta-data', undefined],
    ['IPv6-Loopback-Literal', 'http://[::1]/root.crl', undefined],
    ['IPv4-gemapptes Literal', 'http://[::ffff:127.0.0.1]/root.crl', undefined],
    ['Name auf privates Netz', 'https://crl.example.com/root.crl', '10.20.30.40'],
    ['Name auf CGNAT', 'http://crl.example.com/root.crl', '100.100.100.100'],
    ['Name auf IPv6 Unique Local', 'http://crl.example.com/root.crl', 'fd00::5'],
  ])('%s', async (_case, url, resolved) => {
    const resolve = vi.fn(async () =>
      resolved === undefined ? [] : [{ address: resolved, family: resolved.includes(':') ? 6 : 4 }],
    );
    const requests = [vi.spyOn(http, 'request'), vi.spyOn(https, 'request')];
    await expect(fetchCrl(url, { redirect: 'error' }, resolve)).rejects.toBeInstanceOf(
      CrlTargetRefusedError,
    );
    expect(resolve).toHaveBeenCalledTimes(resolved === undefined ? 0 : 1);
    for (const request of requests) expect(request).not.toHaveBeenCalled();
  });

  it('löst localhost mit dem Systemresolver auf und weist ab', async () => {
    const requests = vi.spyOn(http, 'request');
    await expect(
      fetchCrl('http://localhost/root.crl', { redirect: 'error' }),
    ).rejects.toMatchObject({
      name: 'CrlTargetRefusedError',
      message: expect.stringMatching(/^CRL host resolves to a non-public address: /),
    });
    expect(requests).not.toHaveBeenCalled();
  });
});

describe('requestPinnedCrl: Verbindung nur zu den geprüften Adressen', () => {
  it('verbindet mit der übergebenen Adresse, ohne den Hostnamen aufzulösen', async () => {
    const endpoint = await listen((_request, response) => {
      response.setHeader('content-type', 'application/pkix-crl');
      response.end(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]));
    });
    // crl.example.test ist reserviert und nie auflösbar: nur der gepinnte
    // Lookup kann die Verbindung zu 127.0.0.1 herstellen.
    const response = await requestPinnedCrl(
      new URL(`http://crl.example.test:${endpoint.port}/root.crl`),
      LOCAL,
      { redirect: 'error' },
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
    );
    expect(endpoint.requests.map((request) => [request.url, request.headers.host])).toEqual([
      ['/root.crl', `crl.example.test:${endpoint.port}`],
    ]);
  });

  it.each([301, 302, 303, 307, 308])(
    'verfolgt keinen Redirect (HTTP %i), auch nicht auf einen erreichbaren Host',
    async (status) => {
      const target = await listen((_request, response) => response.end('umgeleitet'));
      const origin = await listen((_request, response) => {
        response.writeHead(status, { location: `http://127.0.0.1:${target.port}/root.crl` });
        response.end();
      });

      await expect(
        requestPinnedCrl(new URL(`http://crl.example.test:${origin.port}/root.crl`), LOCAL, {
          redirect: 'error',
        }),
      ).rejects.toThrow(`CRL endpoint redirects are not permitted (HTTP ${status})`);
      expect(origin.requests).toHaveLength(1);
      expect(target.requests).toHaveLength(0);
    },
  );

  it('liefert einen Fehlerstatus ohne Body, den certificate-path fail-closed abweist', async () => {
    const endpoint = await listen((_request, response) => {
      response.statusCode = 503;
      response.end('nicht verfügbar');
    });
    const response = await requestPinnedCrl(
      new URL(`http://crl.example.test:${endpoint.port}/root.crl`),
      LOCAL,
      { redirect: 'error' },
    );
    expect([response.status, response.ok, response.body]).toEqual([503, false, null]);
  });

  it('bricht eine hängende Verbindung mit dem Abbruchsignal ab', async () => {
    const endpoint = await listen(() => undefined);
    const controller = new AbortController();
    const pending = requestPinnedCrl(
      new URL(`http://crl.example.test:${endpoint.port}/root.crl`),
      LOCAL,
      { redirect: 'error', signal: controller.signal },
    );
    await vi.waitFor(() => expect(endpoint.requests).toHaveLength(1));
    controller.abort(new Error('Zeitlimit erreicht'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Pfadprüfung: gesperrte CRL-Ziele sperren wie eine nicht erreichbare CRL', () => {
  const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;
  let serial = 0x7000;
  const nextSerial = () => (serial += 1).toString(16).padStart(8, '0');

  async function keys(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
  }

  async function chainWithCrlUrl(crlUrl: string): Promise<[X509Certificate, X509Certificate]> {
    const rootKeys = await keys();
    const validity = {
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
    };
    const root = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=SSRF Test Root',
      serialNumber: nextSerial(),
      ...validity,
      signingAlgorithm: SIGNING,
      keys: rootKeys,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
        await SubjectKeyIdentifierExtension.create(rootKeys.publicKey),
      ],
    });
    const leaf = await X509CertificateGenerator.create({
      subject: 'CN=SSRF Test Leaf',
      issuer: root.subject,
      serialNumber: nextSerial(),
      ...validity,
      publicKey: (await keys()).publicKey,
      signingKey: rootKeys.privateKey,
      signingAlgorithm: SIGNING,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new CRLDistributionPointsExtension([crlUrl]),
        await AuthorityKeyIdentifierExtension.create(root.publicKey),
      ],
    });
    return [leaf, root];
  }

  it.each([
    ['Loopback', 'http://127.0.0.1/root.crl'],
    ['Cloud-Metadaten', 'http://169.254.169.254/latest/meta-data'],
    ['privates Netz', 'http://10.0.0.1/root.crl'],
    ['IPv6-Loopback', 'http://[::1]/root.crl'],
    ['IPv4-gemappte Loopback-Adresse', 'http://[::ffff:127.0.0.1]/root.crl'],
    ['localhost über den Systemresolver', 'http://localhost/root.crl'],
  ])('%s', async (_case, crlUrl) => {
    const [leaf, root] = await chainWithCrlUrl(crlUrl);
    const requests = [vi.spyOn(http, 'request'), vi.spyOn(https, 'request')];

    await expect(
      validateCertificatePath([leaf.toString('pem')], [root.toString('pem')]),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({
        message: 'Certificate revocation list could not be downloaded',
        cause: expect.objectContaining({ name: 'CrlTargetRefusedError' }),
      }),
    });
    for (const request of requests) expect(request).not.toHaveBeenCalled();
  });
});
