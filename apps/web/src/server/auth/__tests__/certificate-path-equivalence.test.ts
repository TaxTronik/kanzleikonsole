// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// T-02 (Übergangsnachweis): Dieselben echten Zertifikats- und CRL-Fixtures
// laufen durch die gepatchten Helfer von @simplewebauthn/server 13.3.3 und
// durch @taxtronik/crypto/certificate-path. Ergebnis, Fehlerkette und jeder
// CRL-Abruf (URL, Signal, Redirect-Sperre) müssen übereinstimmen. Einzige
// gewollte Abweichung: Ohne Trust Anchor übersprang die Bibliothek die
// Prüfung, der Repository-Code weist ab. Der Test entfällt mit dem Patch.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  CRLDistributionPointsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
  X509CrlGenerator,
  type X509Certificate,
} from '@peculiar/x509';
import { validateCertificatePath as patchedValidateCertificatePath } from '@simplewebauthn/server/helpers';
import { validateCertificatePath } from '@taxtronik/crypto/certificate-path';

const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const HOUR = 3_600_000;

type Authority = { certificate: X509Certificate; keys: CryptoKeyPair; crlUrl: string };
type CaOptions = {
  basicConstraintsCritical?: boolean;
  keyUsages?: KeyUsageFlags;
  pathLength?: number;
  notBefore?: Date;
  notAfter?: Date;
};
type LeafOptions = {
  notBefore?: Date;
  notAfter?: Date;
  crlUrls?: string[] | null;
  extensions?: Extension[];
};
type CrlOptions = {
  revoked?: X509Certificate[];
  issuer?: string;
  signingKey?: CryptoKey;
  thisUpdate?: Date;
  nextUpdate?: Date | null;
  authorityKey?: CryptoKey;
  extensions?: Extension[];
};
type EndpointReply = Uint8Array | { status: number } | { networkError: true } | { tooLarge: true };
type Fixture = {
  chain: string[];
  anchors: string[];
  endpoints: Record<string, EndpointReply>;
  signal?: AbortSignal;
};

// Erstes Byte < 0x80: X509CrlGenerator kodiert Seriennummern sonst ohne
// führendes Null-Byte, und findRevoked fände den Eintrag in keiner Implementierung.
let serial = 0x3000;
function nextSerial(): string {
  serial += 1;
  return serial.toString(16).padStart(8, '0');
}

async function generateKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(KEY_ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

function crlUrlFor(label: string): string {
  return `https://crl.example.test/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nextSerial()}.crl`;
}

function caExtensions(keys: CryptoKeyPair, options: CaOptions) {
  return Promise.all([
    new BasicConstraintsExtension(
      true,
      options.pathLength ?? 1,
      options.basicConstraintsCritical ?? true,
    ),
    new KeyUsagesExtension(
      options.keyUsages ?? KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
      true,
    ),
    SubjectKeyIdentifierExtension.create(keys.publicKey),
  ]);
}

async function root(label: string, options: CaOptions = {}): Promise<Authority> {
  const keys = await generateKeys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: `CN=${label} Root`,
    serialNumber: nextSerial(),
    notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
    notAfter: options.notAfter ?? new Date(Date.now() + HOUR),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: await caExtensions(keys, options),
  });
  return { certificate, keys, crlUrl: crlUrlFor(`${label} root`) };
}

async function intermediate(
  issuer: Authority,
  label: string,
  options: CaOptions = {},
): Promise<Authority> {
  const keys = await generateKeys();
  const certificate = await X509CertificateGenerator.create({
    subject: `CN=${label} Intermediate`,
    issuer: issuer.certificate.subject,
    serialNumber: nextSerial(),
    notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
    notAfter: options.notAfter ?? new Date(Date.now() + HOUR),
    publicKey: keys.publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      ...(await caExtensions(keys, { pathLength: 0, ...options })),
      new CRLDistributionPointsExtension([issuer.crlUrl]),
      await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey),
    ],
  });
  return { certificate, keys, crlUrl: crlUrlFor(`${label} intermediate`) };
}

async function leaf(issuer: Authority, options: LeafOptions = {}): Promise<X509Certificate> {
  const crlUrls = options.crlUrls === undefined ? [issuer.crlUrl] : options.crlUrls;
  return X509CertificateGenerator.create({
    subject: `CN=Leaf ${nextSerial()}`,
    issuer: issuer.certificate.subject,
    serialNumber: nextSerial(),
    notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
    notAfter: options.notAfter ?? new Date(Date.now() + HOUR),
    publicKey: (await generateKeys()).publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      ...(crlUrls === null ? [] : [new CRLDistributionPointsExtension(crlUrls)]),
      await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey),
      ...(options.extensions ?? []),
    ],
  });
}

async function crl(issuer: Authority, options: CrlOptions = {}): Promise<Uint8Array> {
  const generated = await X509CrlGenerator.create({
    issuer: options.issuer ?? issuer.certificate.subject,
    thisUpdate: options.thisUpdate ?? new Date(Date.now() - 60_000),
    ...(options.nextUpdate === null
      ? {}
      : { nextUpdate: options.nextUpdate ?? new Date(Date.now() + HOUR) }),
    entries: (options.revoked ?? []).map((certificate) => ({
      serialNumber: certificate.serialNumber,
      revocationDate: new Date(Date.now() - 30_000),
    })),
    signingAlgorithm: SIGNING_ALGORITHM,
    signingKey: options.signingKey ?? issuer.keys.privateKey,
    extensions: [
      await AuthorityKeyIdentifierExtension.create(
        options.authorityKey ?? issuer.certificate.publicKey,
      ),
      ...(options.extensions ?? []),
    ],
  });
  return new Uint8Array(generated.rawData);
}

const pem = (certificate: X509Certificate) => certificate.toString('pem');

type Described = { name: string; message: string; cause?: Described } | { value: unknown };

function describeError(error: unknown): Described {
  if (!(error instanceof Error)) return { value: error };
  return {
    name: error.name,
    message: error.message,
    ...(error.cause === undefined ? {} : { cause: describeError(error.cause) }),
  };
}

/** Führt eine Implementierung mit frisch gestubbtem fetch aus und protokolliert jeden Abruf. */
async function observe(fixture: Fixture, run: () => Promise<unknown>) {
  const calls: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([String(input), init]);
      // Wie fetch: ein bereits abgebrochenes Signal verwirft den Abruf sofort.
      init?.signal?.throwIfAborted();
      const reply = fixture.endpoints[String(input)];
      if (!reply || 'networkError' in reply) throw new TypeError('fetch failed');
      if ('status' in reply) return new Response(null, { status: reply.status });
      if ('tooLarge' in reply) {
        return new Response(new Uint8Array(1), {
          headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
        });
      }
      return new Response(new Uint8Array(reply), { status: 200 });
    }),
  );
  try {
    return { outcome: { resolved: await run() }, calls };
  } catch (error) {
    return { outcome: { rejected: describeError(error) }, calls };
  } finally {
    vi.unstubAllGlobals();
  }
}

async function compare(fixture: Fixture, runs = 1) {
  const patched = [];
  const repository = [];
  for (let run = 0; run < runs; run++) {
    patched.push(
      await observe(fixture, () =>
        patchedValidateCertificatePath([...fixture.chain], [...fixture.anchors], {
          signal: fixture.signal,
        }),
      ),
    );
    repository.push(
      await observe(fixture, () =>
        validateCertificatePath(fixture.chain, fixture.anchors, { signal: fixture.signal }),
      ),
    );
  }
  expect(repository).toEqual(patched);
  return repository;
}

function errorChain(described: Described): string[] {
  if ('value' in described) return [String(described.value)];
  return [described.message, ...(described.cause ? errorChain(described.cause) : [])];
}

function expectOutcome(
  outcome: { resolved?: unknown; rejected?: Described },
  expected: Expectation,
) {
  if (expected === true) {
    expect(outcome).toEqual({ resolved: true });
    return;
  }
  expect(outcome.rejected, 'Fixture muss abgewiesen werden').toBeDefined();
  expect(errorChain(outcome.rejected!).join(' | ')).toMatch(expected);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `true`: Kette akzeptiert; RegExp: muss in der Fehlerkette (Meldung und Ursachen) vorkommen. */
type Expectation = true | RegExp;

const scenarios: Array<[string, Expectation, () => Promise<Fixture>]> = [
  [
    'gültige Kette Blatt → Wurzel',
    true,
    async () => {
      const ca = await root('valid-one');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'gültige Kette Blatt → Intermediate → Wurzel',
    true,
    async () => {
      const ca = await root('valid-two');
      const sub = await intermediate(ca, 'valid-two');
      const cert = await leaf(sub);
      return {
        chain: [pem(cert), pem(sub.certificate)],
        anchors: [pem(ca.certificate)],
        endpoints: { [sub.crlUrl]: await crl(sub), [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'gesperrtes Blatt',
    /Found revoked certificate/,
    async () => {
      const ca = await root('revoked-leaf');
      const sub = await intermediate(ca, 'revoked-leaf');
      const cert = await leaf(sub);
      return {
        chain: [pem(cert), pem(sub.certificate)],
        anchors: [pem(ca.certificate)],
        endpoints: {
          [sub.crlUrl]: await crl(sub, { revoked: [cert] }),
          [ca.crlUrl]: await crl(ca),
        },
      };
    },
  ],
  [
    'gesperrtes Intermediate',
    /Found revoked certificate/,
    async () => {
      const ca = await root('revoked-sub');
      const sub = await intermediate(ca, 'revoked-sub');
      const cert = await leaf(sub);
      return {
        chain: [pem(cert), pem(sub.certificate)],
        anchors: [pem(ca.certificate)],
        endpoints: {
          [sub.crlUrl]: await crl(sub),
          [ca.crlUrl]: await crl(ca, { revoked: [sub.certificate] }),
        },
      };
    },
  ],
  [
    'abgelaufenes Blatt',
    /not yet valid or expired/,
    async () => {
      const ca = await root('expired-leaf');
      const cert = await leaf(ca, {
        notBefore: new Date(Date.now() - 2 * HOUR),
        notAfter: new Date(Date.now() - HOUR),
      });
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'noch nicht gültiges Blatt',
    /not yet valid or expired/,
    async () => {
      const ca = await root('future-leaf');
      const cert = await leaf(ca, {
        notBefore: new Date(Date.now() + HOUR),
        notAfter: new Date(Date.now() + 2 * HOUR),
      });
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'fremder Aussteller',
    /did not terminate at the selected trust anchor/,
    async () => {
      const trusted = await root('trusted');
      const foreign = await root('foreign');
      const cert = await leaf(foreign);
      return {
        chain: [pem(cert)],
        anchors: [pem(trusted.certificate)],
        endpoints: { [foreign.crlUrl]: await crl(foreign) },
      };
    },
  ],
  [
    'gleichnamige fremde Wurzel',
    /did not terminate at the selected trust anchor/,
    async () => {
      const trusted = await root('same-name');
      const impostor = await root('same-name');
      const sub = await intermediate(impostor, 'impostor');
      const cert = await leaf(sub);
      return {
        chain: [pem(cert), pem(sub.certificate)],
        anchors: [pem(trusted.certificate)],
        endpoints: { [sub.crlUrl]: await crl(sub), [impostor.crlUrl]: await crl(impostor) },
      };
    },
  ],
  [
    'CRL-Netzwerkfehler',
    /could not be downloaded \| fetch failed/,
    async () => {
      const ca = await root('network');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: { networkError: true } },
      };
    },
  ],
  [
    'CRL-HTTP-Fehler',
    /HTTP 503/,
    async () => {
      const ca = await root('http');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: { status: 503 } },
      };
    },
  ],
  [
    'nicht parsebare CRL',
    /could not be parsed/,
    async () => {
      const ca = await root('garbage');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: new Uint8Array([0x00, 0x01, 0x02]) },
      };
    },
  ],
  [
    'CRL über 5 MiB',
    /exceeds the size limit/,
    async () => {
      const ca = await root('too-large');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: { tooLarge: true } },
      };
    },
  ],
  [
    'gefälschte CRL-Signatur',
    /signature is invalid/,
    async () => {
      const ca = await root('forged');
      const cert = await leaf(ca);
      const forger = await generateKeys();
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca, { signingKey: forger.privateKey }) },
      };
    },
  ],
  [
    'abweichender CRL-Issuer',
    /issuer does not match/,
    async () => {
      const ca = await root('crl-issuer');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca, { issuer: 'CN=Other Root' }) },
      };
    },
  ],
  [
    'abgelaufene CRL',
    /not currently valid/,
    async () => {
      const ca = await root('expired-crl');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: {
          [ca.crlUrl]: await crl(ca, {
            thisUpdate: new Date(Date.now() - 2 * HOUR),
            nextUpdate: new Date(Date.now() - HOUR),
          }),
        },
      };
    },
  ],
  [
    'CRL mit zukünftigem thisUpdate',
    /not currently valid/,
    async () => {
      const ca = await root('future-crl');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: {
          [ca.crlUrl]: await crl(ca, {
            thisUpdate: new Date(Date.now() + HOUR),
            nextUpdate: new Date(Date.now() + 2 * HOUR),
          }),
        },
      };
    },
  ],
  [
    'CRL ohne nextUpdate',
    /not currently valid/,
    async () => {
      const ca = await root('no-next-update');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca, { nextUpdate: null }) },
      };
    },
  ],
  [
    'CRL-AKI passt nicht zum Issuer-SKI',
    /authority key does not match/,
    async () => {
      const ca = await root('aki');
      const cert = await leaf(ca);
      const other = await generateKeys();
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca, { authorityKey: other.publicKey }) },
      };
    },
  ],
  ...(
    [
      ['Delta-CRL', '2.5.29.27', false, [0x02, 0x01, 0x01]],
      ['Issuing Distribution Point', '2.5.29.28', false, [0x30, 0x00]],
      ['Freshest CRL', '2.5.29.46', false, [0x30, 0x00]],
      ['unbekannte kritische CRL-Extension', '1.3.6.1.4.1.55555.1', true, [0x05, 0x00]],
    ] as const
  ).map(([label, oid, critical, value]): [string, Expectation, () => Promise<Fixture>] => [
    label,
    /contains unsupported extensions/,
    async () => {
      const ca = await root(`crl-extension-${oid}`);
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: {
          [ca.crlUrl]: await crl(ca, {
            extensions: [new Extension(oid, critical, new Uint8Array(value))],
          }),
        },
      };
    },
  ]),
  [
    'Issuer ohne cRLSign',
    /not permitted to sign revocation lists/,
    async () => {
      const ca = await root('no-crl-sign', { keyUsages: KeyUsageFlags.keyCertSign });
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'nichtkritische CA-BasicConstraints',
    /not an authorized certificate authority/,
    async () => {
      const ca = await root('non-critical-bc', { basicConstraintsCritical: false });
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'CA ohne keyCertSign',
    /not permitted to sign certificates/,
    async () => {
      const ca = await root('no-cert-sign', { keyUsages: KeyUsageFlags.cRLSign });
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'verletzte Pfadlänge',
    /path length constraint/,
    async () => {
      const ca = await root('path-length', { pathLength: 0 });
      const sub = await intermediate(ca, 'path-length');
      const cert = await leaf(sub);
      return {
        chain: [pem(cert), pem(sub.certificate)],
        anchors: [pem(ca.certificate)],
        endpoints: { [sub.crlUrl]: await crl(sub), [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'unbekannte kritische Zertifikat-Extension',
    /Unsupported critical certificate extension/,
    async () => {
      const ca = await root('critical-extension');
      const cert = await leaf(ca, {
        extensions: [new Extension('1.3.6.1.4.1.55555.2', true, new Uint8Array([0x05, 0x00]))],
      });
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'NameConstraints im Blatt',
    /Unsupported certificate path constraint 2\.5\.29\.30/,
    async () => {
      const ca = await root('name-constraints');
      const cert = await leaf(ca, {
        extensions: [new Extension('2.5.29.30', false, new Uint8Array([0x30, 0x00]))],
      });
      return {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'doppeltes Zertifikat',
    /found duplicate certificates/,
    async () => {
      const ca = await root('duplicate');
      return { chain: [pem(ca.certificate)], anchors: [pem(ca.certificate)], endpoints: {} };
    },
  ],
  [
    'sechs Kettenzertifikate',
    /invalid number of certificates/,
    async () => {
      const ca = await root('six');
      const cert = pem(await leaf(ca));
      return {
        chain: Array.from({ length: 6 }, () => cert),
        anchors: [pem(ca.certificate)],
        endpoints: {},
      };
    },
  ],
  [
    '65 Trust Anchors',
    /invalid number of certificates/,
    async () => {
      const ca = await root('anchors');
      return {
        chain: [pem(await leaf(ca))],
        anchors: Array.from({ length: 65 }, () => pem(ca.certificate)),
        endpoints: {},
      };
    },
  ],
  [
    'passende Anchor an zweiter Stelle',
    true,
    async () => {
      const unrelated = await root('unrelated');
      const ca = await root('second-anchor');
      const cert = await leaf(ca);
      return {
        chain: [pem(cert)],
        anchors: [pem(unrelated.certificate), pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'nur abgelaufene Anchor',
    /No specified trust anchor was valid/,
    async () => {
      const ca = await root('expired-anchor', {
        notBefore: new Date(Date.now() - 2 * HOUR),
        notAfter: new Date(Date.now() - HOUR),
      });
      return { chain: [pem(await leaf(ca))], anchors: [pem(ca.certificate)], endpoints: {} };
    },
  ],
  [
    'nicht parsebare Anchor',
    /Could not parse trust anchor/,
    async () => {
      const ca = await root('broken-anchor');
      return { chain: [pem(await leaf(ca))], anchors: ['kein Zertifikat'], endpoints: {} };
    },
  ],
  [
    'nicht parsebares Kettenzertifikat',
    /Unsupported format/,
    async () => {
      const ca = await root('broken-chain');
      return { chain: ['kein Zertifikat'], anchors: [pem(ca.certificate)], endpoints: {} };
    },
  ],
  [
    'Blatt ohne CRL-Distribution-Point',
    true,
    async () => {
      const ca = await root('no-distribution');
      return {
        chain: [pem(await leaf(ca, { crlUrls: null }))],
        anchors: [pem(ca.certificate)],
        endpoints: {},
      };
    },
  ],
  ...(
    [
      ['CRL-URL mit Zugangsdaten', 'https://user:secret@crl.example.test/list.crl'],
      ['CRL-URL auf Port 8443', 'https://crl.example.test:8443/list.crl'],
      ['CRL-URL mit file-Schema', 'file:///etc/passwd'],
    ] as const
  ).map(([label, url]): [string, Expectation, () => Promise<Fixture>] => [
    label,
    /URL is not permitted/,
    async () => {
      const ca = await root(`url-${label}`);
      return {
        chain: [pem(await leaf(ca, { crlUrls: [url] }))],
        anchors: [pem(ca.certificate)],
        endpoints: {},
      };
    },
  ]),
  [
    'mehrere CRL-Distribution-Points',
    /distribution is unsupported/,
    async () => {
      const ca = await root('multiple-points');
      return {
        chain: [pem(await leaf(ca, { crlUrls: [ca.crlUrl, `${ca.crlUrl}.second`] }))],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      };
    },
  ],
  [
    'bereits abgebrochenes Gesamtzeitlimit',
    /could not be downloaded \| Zeitlimit erreicht/,
    async () => {
      const ca = await root('aborted');
      const controller = new AbortController();
      controller.abort(new Error('Zeitlimit erreicht'));
      return {
        chain: [pem(await leaf(ca))],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
        signal: controller.signal,
      };
    },
  ],
];

describe('T-02: Repository-Pfadprüfung entspricht dem bisherigen SimpleWebAuthn-Patch', () => {
  it.each(scenarios)('%s', async (_case, expected, build) => {
    const [result] = await compare(await build());
    expectOutcome(result!.outcome, expected);
  });

  it('cacht den Sperrstatus in beiden Implementierungen gleich (ein Abruf je Stand)', async () => {
    const ca = await root('cache');
    const cert = await leaf(ca);
    const [first, second] = await compare(
      {
        chain: [pem(cert)],
        anchors: [pem(ca.certificate)],
        endpoints: { [ca.crlUrl]: await crl(ca) },
      },
      2,
    );
    expect(first!.calls).toHaveLength(1);
    expect(second!.calls).toHaveLength(0);
  });

  it('weicht nur ohne Trust Anchor bewusst ab: Patch überspringt, Repository weist ab', async () => {
    const ca = await root('no-anchor');
    const fixture: Fixture = { chain: [pem(await leaf(ca))], anchors: [], endpoints: {} };

    const patched = await observe(fixture, () => patchedValidateCertificatePath(fixture.chain, []));
    const repository = await observe(fixture, () => validateCertificatePath(fixture.chain, []));

    expect(patched).toEqual({ outcome: { resolved: true }, calls: [] });
    expect(repository).toEqual({
      outcome: {
        rejected: { name: 'InvalidX5CChain', message: 'Certificate path has no trust anchor' },
      },
      calls: [],
    });
  });
});
