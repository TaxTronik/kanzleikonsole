// Fachkatalog: ACCESS-TENANT-RLS-001
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
  type X509Crl,
} from '@peculiar/x509';
import { isCertRevoked, validateCertificatePath } from '@simplewebauthn/server/helpers';

const SIGNING_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };
const KEY_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
let serial = 0x1000;

interface CertificateFixtureOptions {
  basicConstraintsCritical?: boolean;
  keyUsages?: KeyUsageFlags;
}

interface CertificateFixture {
  issuer: X509Certificate;
  issuerKeys: CryptoKeyPair;
  leaf: X509Certificate;
  crlUrl: string;
}

function nextSerial(): string {
  serial += 1;
  return serial.toString(16);
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(KEY_ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

async function createCertificateFixture(
  label: string,
  options: CertificateFixtureOptions = {},
): Promise<CertificateFixture> {
  const issuerKeys = await generateKeyPair();
  const issuerExtensions = [
    new BasicConstraintsExtension(true, 1, options.basicConstraintsCritical ?? true),
    new KeyUsagesExtension(
      options.keyUsages ?? KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
      true,
    ),
    await SubjectKeyIdentifierExtension.create(issuerKeys.publicKey),
  ];

  const issuer = await X509CertificateGenerator.createSelfSigned({
    name: `CN=${label} Root`,
    serialNumber: nextSerial(),
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys: issuerKeys,
    extensions: issuerExtensions,
  });
  const leafKeys = await generateKeyPair();
  const crlUrl = `https://crl.example.test/${label}-${nextSerial()}.crl`;
  const leaf = await X509CertificateGenerator.create({
    subject: `CN=${label} Attestation`,
    issuer: issuer.subject,
    serialNumber: nextSerial(),
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    publicKey: leafKeys.publicKey,
    signingKey: issuerKeys.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new CRLDistributionPointsExtension([crlUrl]),
      await AuthorityKeyIdentifierExtension.create(issuer.publicKey),
    ],
  });

  return { issuer, issuerKeys, leaf, crlUrl };
}

async function createCrl(
  fixture: CertificateFixture,
  options: {
    issuer?: string;
    signingKey?: CryptoKey;
    thisUpdate?: Date;
    nextUpdate?: Date;
    omitNextUpdate?: boolean;
    authorityKey?: CryptoKey;
    extensions?: Extension[];
  } = {},
): Promise<X509Crl> {
  return X509CrlGenerator.create({
    issuer: options.issuer ?? fixture.issuer.subject,
    thisUpdate: options.thisUpdate ?? new Date(Date.now() - 60_000),
    ...(options.omitNextUpdate
      ? {}
      : { nextUpdate: options.nextUpdate ?? new Date(Date.now() + 3_600_000) }),
    signingAlgorithm: SIGNING_ALGORITHM,
    signingKey: options.signingKey ?? fixture.issuerKeys.privateKey,
    extensions: [
      await AuthorityKeyIdentifierExtension.create(
        options.authorityKey ?? fixture.issuer.publicKey,
      ),
      ...(options.extensions ?? []),
    ],
  });
}

function respondWithCrl(crl: X509Crl): Response {
  return new Response(new Uint8Array(crl.rawData), { status: 200 });
}

function certificateWithCrl(): X509Certificate {
  return {
    extensions: [new CRLDistributionPointsExtension(['https://crl.example.test/list.crl'])],
    serialNumber: '01',
  } as unknown as X509Certificate;
}

function certificateWithScopedDistributionPoint(point: Record<string, unknown>): X509Certificate {
  const extension = new CRLDistributionPointsExtension([
    'https://crl.example.test/scoped-list.crl',
  ]);
  Object.defineProperty(extension, 'distributionPoints', {
    configurable: true,
    value: [point],
  });
  return {
    extensions: [extension],
    serialNumber: nextSerial(),
  } as unknown as X509Certificate;
}

function certificateIssuer(): X509Certificate {
  return {
    subject: 'CN=Test issuer',
    getExtension: () => null,
    getThumbprint: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as X509Certificate;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('versionsgebundener SimpleWebAuthn-CRL-Patch', () => {
  it('behandelt Netzwerk-, HTTP- und Parsefehler fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network unavailable')));
    await expect(
      isCertRevoked(certificateWithCrl(), { issuer: certificateIssuer() }),
    ).rejects.toThrow(/could not be downloaded/i);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })));
    await expect(
      isCertRevoked(certificateWithCrl(), { issuer: certificateIssuer() }),
    ).rejects.toThrow(/could not be downloaded/i);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([0x00, 0x01, 0x02]))),
    );
    await expect(
      isCertRevoked(certificateWithCrl(), { issuer: certificateIssuer() }),
    ).rejects.toThrow(/could not be parsed/i);
  });

  it('reicht den Abbruch der Gesamtprüfung bis zum CRL-Abruf durch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = isCertRevoked(certificateWithCrl(), {
      signal: controller.signal,
      issuer: certificateIssuer(),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('deadline reached'));

    await expect(pending).rejects.toThrow(/could not be downloaded/i);
    expect(fetchMock).toHaveBeenCalledWith('https://crl.example.test/list.crl', {
      signal: controller.signal,
      redirect: 'error',
    });
  });

  it('akzeptiert eine frische, vom Zertifikatsaussteller signierte CRL', async () => {
    const fixture = await createCertificateFixture('Valid CRL');
    const crl = await createCrl(fixture);
    const fetchMock = vi.fn().mockResolvedValue(respondWithCrl(crl));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(new URL(fixture.crlUrl).toString(), {
      signal: undefined,
      redirect: 'error',
    });
  });

  it('verifiziert eine SHA-256-CRL mit dem PublicKey eines SHA-384-RSA-Ausstellers', async () => {
    const issuerKeys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-384',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const issuer = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=Mixed RSA Hash Root',
      serialNumber: nextSerial(),
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
      keys: issuerKeys,
      extensions: [
        new BasicConstraintsExtension(true, 1, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
        await SubjectKeyIdentifierExtension.create(issuerKeys.publicKey),
      ],
    });
    const leafKeys = await generateKeyPair();
    const crlUrl = `https://crl.example.test/mixed-rsa-hash-${nextSerial()}.crl`;
    const leaf = await X509CertificateGenerator.create({
      subject: 'CN=Mixed RSA Hash Attestation',
      issuer: issuer.subject,
      serialNumber: nextSerial(),
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
      publicKey: leafKeys.publicKey,
      signingKey: issuerKeys.privateKey,
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new CRLDistributionPointsExtension([crlUrl]),
        await AuthorityKeyIdentifierExtension.create(issuer.publicKey),
      ],
    });
    const issuerPrivateJwk = await crypto.subtle.exportKey('jwk', issuerKeys.privateKey);
    const crlSigningKey = await crypto.subtle.importKey(
      'jwk',
      { ...issuerPrivateJwk, alg: 'RS256' },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const crl = await X509CrlGenerator.create({
      issuer: issuer.subject,
      thisUpdate: new Date(Date.now() - 60_000),
      nextUpdate: new Date(Date.now() + 3_600_000),
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      signingKey: crlSigningKey,
      extensions: [await AuthorityKeyIdentifierExtension.create(issuer.publicKey)],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respondWithCrl(crl)));

    await expect(isCertRevoked(leaf, { issuer })).resolves.toBe(false);
  });

  it('verwirft eine CRL mit falscher Signatur fail-closed', async () => {
    const fixture = await createCertificateFixture('Wrong Signature');
    const unrelatedKeys = await generateKeyPair();
    const crl = await createCrl(fixture, { signingKey: unrelatedKeys.privateKey });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respondWithCrl(crl)));

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be verified/i),
      cause: expect.objectContaining({
        message: expect.stringMatching(/signature is invalid/i),
      }),
    });
  });

  it('verwirft eine CRL mit abweichendem Aussteller fail-closed', async () => {
    const fixture = await createCertificateFixture('Wrong Issuer');
    const crl = await createCrl(fixture, { issuer: 'CN=Other Root' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respondWithCrl(crl)));

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be verified/i),
      cause: expect.objectContaining({
        message: expect.stringMatching(/issuer does not match/i),
      }),
    });
  });

  it('verwirft eine abgelaufene CRL fail-closed', async () => {
    const fixture = await createCertificateFixture('Expired CRL');
    const crl = await createCrl(fixture, {
      thisUpdate: new Date(Date.now() - 7_200_000),
      nextUpdate: new Date(Date.now() - 3_600_000),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respondWithCrl(crl)));

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be verified/i),
      cause: expect.objectContaining({
        message: expect.stringMatching(/not currently valid/i),
      }),
    });
  });

  it.each([
    [
      'zukünftigem thisUpdate',
      {
        thisUpdate: new Date(Date.now() + 3_600_000),
        nextUpdate: new Date(Date.now() + 7_200_000),
      },
    ],
    ['fehlendem nextUpdate', { omitNextUpdate: true }],
  ])('verwirft eine CRL mit %s fail-closed', async (_case, options) => {
    const fixture = await createCertificateFixture(`Freshness ${_case}`);
    const crl = await createCrl(fixture, options);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respondWithCrl(crl)));

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be verified/i),
      cause: expect.objectContaining({
        message: expect.stringMatching(/not currently valid/i),
      }),
    });
  });

  it('bindet die CRL-AKI an den Issuer-SKI', async () => {
    const fixture = await createCertificateFixture('Wrong AKI');
    const unrelatedKeys = await generateKeyPair();
    const crl = await createCrl(fixture, { authorityKey: unrelatedKeys.publicKey });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respondWithCrl(crl)));

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be verified/i),
      cause: expect.objectContaining({
        message: expect.stringMatching(/authority key does not match/i),
      }),
    });
  });

  it('verlangt cRLSign beim ausstellenden CA-Schlüssel', async () => {
    const fixture = await createCertificateFixture('Missing CRL Sign', {
      keyUsages: KeyUsageFlags.keyCertSign,
    });
    const crl = await createCrl(fixture);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respondWithCrl(crl)));

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be verified/i),
      cause: expect.objectContaining({
        message: expect.stringMatching(/not permitted to sign revocation lists/i),
      }),
    });
  });

  it.each([
    'file:///etc/passwd',
    'https://user:secret@crl.example.test/list.crl',
    'https://crl.example.test:8443/list.crl',
  ])('verweigert die CRL-URL %s vor dem Abruf', async (crlUrl) => {
    const certificate = {
      extensions: [new CRLDistributionPointsExtension([crlUrl])],
      serialNumber: nextSerial(),
    } as unknown as X509Certificate;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(isCertRevoked(certificate, { issuer: certificateIssuer() })).rejects.toThrow(
      /not permitted/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verwirft mehrere CRL Distribution Points vor dem ersten Abruf', async () => {
    const certificate = {
      extensions: [
        new CRLDistributionPointsExtension([
          'https://crl.example.test/first.crl',
          'https://crl.example.test/second.crl',
        ]),
      ],
      serialNumber: nextSerial(),
    } as unknown as X509Certificate;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(isCertRevoked(certificate, { issuer: certificateIssuer() })).rejects.toThrow(
      /distribution.*unsupported/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['zusätzlichem Basis-CRL-Punkt', true],
    ['ohne Basis-CRL-Punkt', false],
  ])(
    'verwirft eine Zertifikat-Freshest-CRL mit %s vor dem ersten Abruf',
    async (_case, includeBaseCrl) => {
      const extensions: Extension[] = [
        new Extension('2.5.29.46', false, new Uint8Array([0x30, 0x00])),
      ];
      if (includeBaseCrl) {
        extensions.unshift(
          new CRLDistributionPointsExtension(['https://crl.example.test/base.crl']),
        );
      }
      const certificate = {
        extensions,
        serialNumber: nextSerial(),
      } as unknown as X509Certificate;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(isCertRevoked(certificate, { issuer: certificateIssuer() })).rejects.toThrow(
        /freshest.*unsupported/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'mehrere GeneralNames',
      {
        distributionPoint: {
          fullName: [
            { uniformResourceIdentifier: 'https://crl.example.test/first.crl' },
            { uniformResourceIdentifier: 'https://crl.example.test/second.crl' },
          ],
        },
      },
    ],
    [
      'Reason-Scope',
      {
        distributionPoint: {
          fullName: [{ uniformResourceIdentifier: 'https://crl.example.test/list.crl' }],
        },
        reasons: 1,
      },
    ],
    [
      'cRLIssuer-Scope',
      {
        distributionPoint: {
          fullName: [{ uniformResourceIdentifier: 'https://crl.example.test/list.crl' }],
        },
        cRLIssuer: [{ directoryName: 'CN=Other CRL Issuer' }],
      },
    ],
    [
      'relativen Distribution-Point-Namen',
      {
        distributionPoint: {
          nameRelativeToCRLIssuer: { commonName: 'Scoped CRL' },
        },
      },
    ],
  ])('verwirft %s vor dem ersten CRL-Abruf', async (_case, point) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      isCertRevoked(certificateWithScopedDistributionPoint(point), {
        issuer: certificateIssuer(),
      }),
    ).rejects.toThrow(/distribution.*unsupported/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['Delta-CRL', '2.5.29.27', false, new Uint8Array([0x02, 0x01, 0x01])],
    ['Issuing Distribution Point', '2.5.29.28', false, new Uint8Array([0x30, 0x00])],
    ['Freshest CRL', '2.5.29.46', false, new Uint8Array([0x30, 0x00])],
    ['unbekannte kritische Extension', '1.3.6.1.4.1.55555.1', true, new Uint8Array([0x05, 0x00])],
  ])('verwirft %s in einer CRL fail-closed', async (_case, oid, critical, value) => {
    const fixture = await createCertificateFixture(`Unsupported CRL Extension ${oid}`);
    const crl = await createCrl(fixture, {
      extensions: [new Extension(oid, critical, value)],
    });
    const fetchMock = vi.fn().mockResolvedValue(respondWithCrl(crl));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isCertRevoked(fixture.leaf, { issuer: fixture.issuer })).rejects.toMatchObject({
      message: expect.stringMatching(/could not be verified/i),
      cause: expect.objectContaining({
        message: expect.stringMatching(/extension.*not supported|unsupported.*extension/i),
      }),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('begrenzt CRLs anhand Content-Length vor der Allokation', async () => {
    const arrayBuffer = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => String(5 * 1024 * 1024 + 1) },
        body: null,
        arrayBuffer,
      }),
    );

    await expect(
      isCertRevoked(certificateWithCrl(), { issuer: certificateIssuer() }),
    ).rejects.toThrow(/could not be downloaded/i);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('prüft eine vertrauenswürdige Zertifikatskette vor jedem CRL-Abruf', async () => {
    const untrusted = await createCertificateFixture('Untrusted Leaf');
    const trusted = await createCertificateFixture('Trusted Root');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      validateCertificatePath([untrusted.leaf.toString('pem')], [trusted.issuer.toString('pem')]),
    ).rejects.toMatchObject({ name: 'InvalidX5CChain' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verlangt kritische CA-BasicConstraints vor jedem CRL-Abruf', async () => {
    const fixture = await createCertificateFixture('Non-critical Basic Constraints', {
      basicConstraintsCritical: false,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      validateCertificatePath([fixture.leaf.toString('pem')], [fixture.issuer.toString('pem')]),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({
        message: expect.stringMatching(/authorized certificate authority/i),
      }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verlangt keyCertSign beim CA-KeyUsage vor jedem CRL-Abruf', async () => {
    const fixture = await createCertificateFixture('Missing Key Cert Sign', {
      keyUsages: KeyUsageFlags.cRLSign,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      validateCertificatePath([fixture.leaf.toString('pem')], [fixture.issuer.toString('pem')]),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({
        message: expect.stringMatching(/not permitted to sign certificates/i),
      }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('erzwingt die CA-Pfadlängenbegrenzung vor jedem CRL-Abruf', async () => {
    const rootKeys = await generateKeyPair();
    const root = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=Path Length Root',
      serialNumber: nextSerial(),
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
      signingAlgorithm: SIGNING_ALGORITHM,
      keys: rootKeys,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      ],
    });
    const intermediateKeys = await generateKeyPair();
    const intermediate = await X509CertificateGenerator.create({
      subject: 'CN=Subordinate CA',
      issuer: root.subject,
      serialNumber: nextSerial(),
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
      publicKey: intermediateKeys.publicKey,
      signingKey: rootKeys.privateKey,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
        await AuthorityKeyIdentifierExtension.create(root.publicKey),
      ],
    });
    const leafKeys = await generateKeyPair();
    const leaf = await X509CertificateGenerator.create({
      subject: 'CN=Path Length Leaf',
      issuer: intermediate.subject,
      serialNumber: nextSerial(),
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
      publicKey: leafKeys.publicKey,
      signingKey: intermediateKeys.privateKey,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        await AuthorityKeyIdentifierExtension.create(intermediate.publicKey),
      ],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      validateCertificatePath(
        [leaf.toString('pem'), intermediate.toString('pem')],
        [root.toString('pem')],
      ),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({
        message: expect.stringMatching(/path length constraint/i),
      }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
