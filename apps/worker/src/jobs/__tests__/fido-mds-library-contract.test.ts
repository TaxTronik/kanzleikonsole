// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// T-02: Worker-Pfad mit echten Zertifikaten, echter RS256-Signatur und dem
// ungepatchten @simplewebauthn/server 13.3.3: Signer-Identität, JWT-Signatur
// durch die Bibliothek (ohne deren Ketten-/CRL-Prüfung), danach Kette und CRLs
// durch @taxtronik/crypto/certificate-path gegen die Anker. Die gepinnten
// GlobalSign-Anker ersetzt hier eine Test-Wurzel; ein eigener Fall vergleicht
// die echten Anker mit der Voreinstellung der Bibliothek.
// =============================================================================

import { webcrypto, X509Certificate as NodeX509Certificate } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  CRLDistributionPointsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
  X509CrlGenerator,
  type X509Certificate,
} from '@peculiar/x509';
import { SettingsService } from '@simplewebauthn/server';

// Vor jedem Lauf von downloadVerifiedFidoMetadata, der die Bibliotheksanker leert.
const LIBRARY_MDS_ROOTS = SettingsService.getRootCertificates({ identifier: 'mds' });

const anchors = vi.hoisted(() => ({ pem: [] as string[] }));
vi.mock('../fido-mds-trust-anchors', () => ({
  get FIDO_MDS_TRUST_ANCHORS() {
    return anchors.pem;
  },
}));

import { downloadVerifiedFidoMetadata, FIDO_MDS_URL } from '../fido-mds-verify';

type CryptoKeyPair = webcrypto.CryptoKeyPair;
type Authority = {
  certificate: X509Certificate;
  keys: CryptoKeyPair;
  crlUrl: string;
  signing: typeof EC_SIGNING | typeof RSA_SIGNING;
};

const EC_SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;
const RSA_SIGNING = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const HOUR = 3_600_000;

// Erstes Byte < 0x80, damit findRevoked Sperreinträge des Generators findet.
let serial = 0x7000;
const nextSerial = () => (serial += 1).toString(16).padStart(8, '0');
const validity = () => ({
  notBefore: new Date(Date.now() - 60_000),
  notAfter: new Date(Date.now() + HOUR),
});

async function ecKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

async function rsaKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { ...RSA_SIGNING, modulusLength: 2048, publicExponent: new Uint8Array([0x01, 0x00, 0x01]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

async function caExtensions(keys: CryptoKeyPair, pathLength: number) {
  return [
    new BasicConstraintsExtension(true, pathLength, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    await SubjectKeyIdentifierExtension.create(keys.publicKey),
  ];
}

async function root(label: string): Promise<Authority> {
  const keys = await ecKeys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: `CN=${label}`,
    serialNumber: nextSerial(),
    ...validity(),
    signingAlgorithm: EC_SIGNING,
    keys,
    extensions: await caExtensions(keys, 1),
  });
  return {
    certificate,
    keys,
    crlUrl: `http://crl.example.test/root-${nextSerial()}.crl`,
    signing: EC_SIGNING,
  };
}

/**
 * Kette wie beim echten MDS: RSA-Signer → RSA-Intermediate (GlobalSign-Name) →
 * Wurzel. SimpleWebAuthn leitet den JWT-Algorithmus aus der Signatur des
 * Signer-Zertifikats ab; deshalb signiert auch das Intermediate mit RSA.
 */
async function signerChain(anchor: Authority) {
  const intermediateKeys = await rsaKeys();
  const intermediate: Authority = {
    keys: intermediateKeys,
    crlUrl: `http://crl.example.test/intermediate-${nextSerial()}.crl`,
    signing: RSA_SIGNING,
    certificate: await X509CertificateGenerator.create({
      subject: [{ CN: ['GlobalSign GCC R46 EV TLS CA 2025'] }, { O: ['GlobalSign nv-sa'] }],
      issuer: anchor.certificate.subject,
      serialNumber: nextSerial(),
      ...validity(),
      publicKey: intermediateKeys.publicKey,
      signingKey: anchor.keys.privateKey,
      signingAlgorithm: anchor.signing,
      extensions: [
        ...(await caExtensions(intermediateKeys, 0)),
        new CRLDistributionPointsExtension([anchor.crlUrl]),
        await AuthorityKeyIdentifierExtension.create(anchor.certificate.publicKey),
      ],
    }),
  };
  const signerKeys = await rsaKeys();
  const signer = await X509CertificateGenerator.create({
    subject: [{ CN: ['mds.fidoalliance.org'] }, { O: ['Fido Alliance, Inc.'] }],
    issuer: intermediate.certificate.subject,
    serialNumber: nextSerial(),
    ...validity(),
    publicKey: signerKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    signingAlgorithm: RSA_SIGNING,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension([{ type: 'dns', value: 'mds.fidoalliance.org' }]),
      new CRLDistributionPointsExtension([intermediate.crlUrl]),
      await AuthorityKeyIdentifierExtension.create(intermediate.certificate.publicKey),
    ],
  });
  return { intermediate, signer, signerKeys };
}

async function crl(issuer: Authority, revoked: X509Certificate[] = []): Promise<Response> {
  const list = await X509CrlGenerator.create({
    issuer: issuer.certificate.subject,
    thisUpdate: new Date(Date.now() - 60_000),
    nextUpdate: new Date(Date.now() + HOUR),
    entries: revoked.map((certificate) => ({
      serialNumber: certificate.serialNumber,
      revocationDate: new Date(Date.now() - 30_000),
    })),
    signingAlgorithm: issuer.signing,
    signingKey: issuer.keys.privateKey,
    extensions: [await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey)],
  });
  return new Response(new Uint8Array(list.rawData));
}

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString('base64url');

async function signedBlob(
  chain: Awaited<ReturnType<typeof signerChain>>,
  options: { tamper?: boolean } = {},
): Promise<string> {
  const header = base64url(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
      x5c: [chain.signer, chain.intermediate.certificate].map((certificate) =>
        Buffer.from(certificate.rawData).toString('base64'),
      ),
    }),
  );
  const payload = (no: number) =>
    base64url(
      JSON.stringify({
        legalHeader: 'Test',
        no,
        nextUpdate: '2099-01-01',
        entries: [
          {
            aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            metadataStatement: { aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            statusReports: [{ status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-01-01' }],
            timeOfLastStatusChange: '2020-01-01',
          },
        ],
      }),
    );
  const signature = await crypto.subtle.sign(
    RSA_SIGNING,
    chain.signerKeys.privateKey,
    new TextEncoder().encode(`${header}.${payload(42)}`),
  );
  // Manipuliert: Signatur über Serie 42, ausgeliefert mit Serie 43.
  return `${header}.${payload(options.tamper ? 43 : 42)}.${base64url(new Uint8Array(signature))}`;
}

function stubEndpoints(responses: Record<string, () => Promise<Response> | Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const respond = responses[String(input)];
    if (!respond) throw new TypeError(`fetch failed: ${String(input)}`);
    return respond();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let anchor: Authority;
beforeEach(async () => {
  anchor = await root('Test MDS Root');
  anchors.pem = [anchor.certificate.toString('pem')];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T-02: FIDO-MDS-BLOB mit echter Kette', () => {
  it('prüft Signatur durch SimpleWebAuthn, danach Kette und beide CRLs fail-closed', async () => {
    const chain = await signerChain(anchor);
    const blob = await signedBlob(chain);
    const fetchMock = stubEndpoints({
      [FIDO_MDS_URL]: () => new Response(blob),
      [chain.intermediate.crlUrl]: () => crl(chain.intermediate),
      [anchor.crlUrl]: () => crl(anchor),
    });

    await expect(downloadVerifiedFidoMetadata()).resolves.toMatchObject({
      blob,
      serial: 42,
      entries: [expect.objectContaining({ aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })],
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.redirect])).toEqual([
      [FIDO_MDS_URL, undefined],
      [chain.intermediate.crlUrl, 'error'],
      [anchor.crlUrl, 'error'],
    ]);
    // Die CRL-Abrufe tragen das Abbruchsignal des 30-Sekunden-Zeitlimits.
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(fetchMock.mock.calls[0]?.[1]?.signal);
    expect(SettingsService.getRootCertificates({ identifier: 'mds' })).toEqual([]);
  });

  it('weist einen BLOB mit gesperrtem Signer-Zertifikat ab', async () => {
    const chain = await signerChain(anchor);
    const blob = await signedBlob(chain);
    stubEndpoints({
      [FIDO_MDS_URL]: () => new Response(blob),
      [chain.intermediate.crlUrl]: () => crl(chain.intermediate, [chain.signer]),
      [anchor.crlUrl]: () => crl(anchor),
    });

    await expect(downloadVerifiedFidoMetadata()).rejects.toMatchObject({
      message: 'BLOB certificate path could not be validated',
      cause: expect.objectContaining({
        name: 'InvalidX5CChain',
        cause: expect.objectContaining({
          message: 'Found revoked certificate in certificate path',
        }),
      }),
    });
  });

  it('sperrt fail-closed, wenn eine CRL nicht abrufbar ist', async () => {
    const chain = await signerChain(anchor);
    const blob = await signedBlob(chain);
    stubEndpoints({
      [FIDO_MDS_URL]: () => new Response(blob),
      [chain.intermediate.crlUrl]: () => crl(chain.intermediate),
    });

    await expect(downloadVerifiedFidoMetadata()).rejects.toMatchObject({
      message: 'BLOB certificate path could not be validated',
      cause: expect.objectContaining({
        cause: expect.objectContaining({
          message: 'Certificate revocation list could not be downloaded',
        }),
      }),
    });
  });

  it('weist eine Kette unter einer nicht gepinnten Wurzel ohne CRL-Abruf ab', async () => {
    const foreign = await root('Foreign MDS Root');
    const chain = await signerChain(foreign);
    const blob = await signedBlob(chain);
    const fetchMock = stubEndpoints({ [FIDO_MDS_URL]: () => new Response(blob) });

    await expect(downloadVerifiedFidoMetadata()).rejects.toMatchObject({
      message: 'BLOB certificate path could not be validated',
      cause: expect.objectContaining({ name: 'InvalidX5CChain' }),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('prüft bei ungültiger Signatur keine Kette und lädt keine CRL', async () => {
    const chain = await signerChain(anchor);
    const blob = await signedBlob(chain, { tamper: true });
    const fetchMock = stubEndpoints({ [FIDO_MDS_URL]: () => new Response(blob) });

    await expect(downloadVerifiedFidoMetadata()).rejects.toThrow(
      'BLOB signature could not be verified',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('pinnt dieselben MDS-Wurzeln wie SimpleWebAuthn 13.3.3', async () => {
    const { FIDO_MDS_TRUST_ANCHORS } = await vi.importActual<
      typeof import('../fido-mds-trust-anchors')
    >('../fido-mds-trust-anchors');
    const fingerprint = (pem: string) => new NodeX509Certificate(pem).fingerprint256;

    expect(FIDO_MDS_TRUST_ANCHORS.map(fingerprint)).toEqual(LIBRARY_MDS_ROOTS.map(fingerprint));
    expect(FIDO_MDS_TRUST_ANCHORS.map(fingerprint)).toEqual([
      'CB:B5:22:D7:B7:F1:27:AD:6A:01:13:86:5B:DF:1C:D4:10:2E:7D:07:59:AF:63:5A:7C:F4:72:0D:C9:63:C5:3B',
      '4F:A3:12:6D:8D:3A:11:D1:C4:85:5A:4F:80:7C:BA:D6:CF:91:9D:3A:5A:88:B0:3B:EA:2C:63:72:D9:3C:40:C9',
    ]);
  });
});
