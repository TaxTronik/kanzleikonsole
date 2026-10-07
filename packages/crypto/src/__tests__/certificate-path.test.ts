// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// T-02: gehärtete Pfad- und Sperrlistenprüfung mit echten Zertifikaten. Die
// Detailfälle der CRL-Auswertung (URL-Policy, Distribution Points,
// CRL-Extensions, Größengrenzen, AKI/cRLSign) belegt zusätzlich
// apps/web/src/server/auth/__tests__/simplewebauthn-crl-hardening.test.ts.
// Den SSRF-Schutz des Abrufs (Adressklassen, Pinning, Redirects) belegt
// crl-fetch.test.ts; hier beantwortet ein Stub des globalen fetch die
// CRL-URLs mit genau den Argumenten, die certificate-path an fetchCrl gibt.
// =============================================================================

import type { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../crl-fetch', () => ({
  fetchCrl: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  CRLDistributionPointsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
  X509CrlGenerator,
  type Extension,
  type X509Certificate,
} from '@peculiar/x509';
import { isCertRevoked, validateCertificatePath } from '../certificate-path';

const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const HOUR = 3_600_000;

// Das Paket kompiliert ohne DOM-Bibliothek; WebCrypto-Typen kommen aus node:crypto.
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
type Authority = { certificate: X509Certificate; keys: CryptoKeyPair; crlUrl: string };
type Validity = { notBefore?: Date; notAfter?: Date };

// Erstes Byte < 0x80: X509CrlGenerator kodiert Seriennummern sonst ohne
// führendes Null-Byte, und findRevoked fände den Sperreintrag nicht.
let serial = 0x5000;
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

function validity(options: Validity = {}): { notBefore: Date; notAfter: Date } {
  return {
    notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
    notAfter: options.notAfter ?? new Date(Date.now() + HOUR),
  };
}

/** Eindeutige, bereits kanonische URL (ASCII), damit der Abruf-Stub sie wiederfindet. */
function crlUrlFor(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `https://crl.example.test/${slug}-${nextSerial()}.crl`;
}

async function createRoot(label: string, options: Validity = {}): Promise<Authority> {
  const keys = await generateKeys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: `CN=${label} Root`,
    serialNumber: nextSerial(),
    ...validity(options),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      new BasicConstraintsExtension(true, 1, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certificate, keys, crlUrl: crlUrlFor(label) };
}

async function issueCertificate(
  issuer: Authority,
  subject: string,
  options: Validity & { ca?: boolean; publicKey?: CryptoKey; crlDistribution?: boolean } = {},
): Promise<X509Certificate> {
  const extensions: Extension[] = options.ca
    ? [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
        await SubjectKeyIdentifierExtension.create(options.publicKey!),
      ]
    : [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      ];
  if (options.crlDistribution ?? true) {
    extensions.push(new CRLDistributionPointsExtension([issuer.crlUrl]));
  }
  extensions.push(await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey));
  return X509CertificateGenerator.create({
    subject,
    issuer: issuer.certificate.subject,
    serialNumber: nextSerial(),
    ...validity(options),
    publicKey: options.publicKey ?? (await generateKeys()).publicKey,
    signingKey: issuer.keys.privateKey,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions,
  });
}

async function createIntermediate(
  root: Authority,
  label: string,
  options: Validity = {},
): Promise<Authority> {
  const keys = await generateKeys();
  const certificate = await issueCertificate(root, `CN=${label} Intermediate`, {
    ...options,
    ca: true,
    publicKey: keys.publicKey,
  });
  return { certificate, keys, crlUrl: crlUrlFor(`${label} intermediate`) };
}

async function createCrl(
  issuer: Authority,
  options: { revoked?: X509Certificate[]; signingKey?: CryptoKey } = {},
): Promise<Response> {
  const crl = await X509CrlGenerator.create({
    issuer: issuer.certificate.subject,
    thisUpdate: new Date(Date.now() - 60_000),
    nextUpdate: new Date(Date.now() + HOUR),
    entries: (options.revoked ?? []).map((certificate) => ({
      serialNumber: certificate.serialNumber,
      revocationDate: new Date(Date.now() - 30_000),
    })),
    signingAlgorithm: SIGNING_ALGORITHM,
    signingKey: options.signingKey ?? issuer.keys.privateKey,
    extensions: [await AuthorityKeyIdentifierExtension.create(issuer.certificate.publicKey)],
  });
  return new Response(new Uint8Array(crl.rawData), { status: 200 });
}

/** Beantwortet CRL-Abrufe je URL; unbekannte URLs scheitern wie ein Netzfehler. */
function stubCrlEndpoints(responses: Record<string, () => Promise<Response> | Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const respond = responses[String(input)];
    if (!respond) throw new TypeError(`fetch failed: ${String(input)}`);
    return respond();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const pem = (certificate: X509Certificate) => certificate.toString('pem');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateCertificatePath', () => {
  it('akzeptiert Blatt → Intermediate → Wurzel und prüft beide Sperrlisten mit dem Abbruchsignal', async () => {
    const root = await createRoot('Valid Path');
    const intermediate = await createIntermediate(root, 'Valid Path');
    const leaf = await issueCertificate(intermediate, 'CN=Valid Path Leaf');
    const fetchMock = stubCrlEndpoints({
      [intermediate.crlUrl]: () => createCrl(intermediate),
      [root.crlUrl]: () => createCrl(root),
    });
    const controller = new AbortController();

    await expect(
      validateCertificatePath([pem(leaf), pem(intermediate.certificate)], [pem(root.certificate)], {
        signal: controller.signal,
      }),
    ).resolves.toBe(true);
    // Erst das Blatt gegen die CRL seines Issuers, dann das Intermediate gegen die Wurzel.
    expect(fetchMock.mock.calls).toEqual([
      [intermediate.crlUrl, { signal: controller.signal, redirect: 'error' }],
      [root.crlUrl, { signal: controller.signal, redirect: 'error' }],
    ]);
  });

  it('cacht den authentisierten Sperrstatus höchstens bis zum nextUpdate der CRL', async () => {
    const root = await createRoot('Cached Status');
    const leaf = await issueCertificate(root, 'CN=Cached Status Leaf');
    const fetchMock = stubCrlEndpoints({ [root.crlUrl]: () => createCrl(root) });

    await validateCertificatePath([pem(leaf)], [pem(root.certificate)]);
    await validateCertificatePath([pem(leaf)], [pem(root.certificate)]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('prüft ohne CRL-Distribution-Point keine Sperrliste für dieses Zertifikat', async () => {
    const root = await createRoot('Without Distribution Point');
    const leaf = await issueCertificate(root, 'CN=Without Distribution Point Leaf', {
      crlDistribution: false,
    });
    const fetchMock = stubCrlEndpoints({});

    await expect(validateCertificatePath([pem(leaf)], [pem(root.certificate)])).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'abgelaufenes Blatt',
      { notBefore: new Date(Date.now() - 2 * HOUR), notAfter: new Date(Date.now() - HOUR) },
    ],
    [
      'noch nicht gültiges Blatt',
      { notBefore: new Date(Date.now() + HOUR), notAfter: new Date(Date.now() + 2 * HOUR) },
    ],
  ])('weist ein %s vor jedem CRL-Abruf ab', async (_case, leafValidity) => {
    const root = await createRoot(`Validity ${_case}`);
    const leaf = await issueCertificate(root, 'CN=Out Of Validity Leaf', leafValidity);
    const fetchMock = stubCrlEndpoints({ [root.crlUrl]: () => createCrl(root) });

    await expect(
      validateCertificatePath([pem(leaf)], [pem(root.certificate)]),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^Found invalid certificate in x5c/),
      cause: expect.objectContaining({ message: 'Certificate is not yet valid or expired' }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('weist ein abgelaufenes Intermediate vor jedem CRL-Abruf ab', async () => {
    const root = await createRoot('Expired Intermediate');
    const intermediate = await createIntermediate(root, 'Expired Intermediate', {
      notBefore: new Date(Date.now() - 2 * HOUR),
      notAfter: new Date(Date.now() - HOUR),
    });
    const leaf = await issueCertificate(intermediate, 'CN=Expired Intermediate Leaf');
    const fetchMock = stubCrlEndpoints({});

    await expect(
      validateCertificatePath([pem(leaf), pem(intermediate.certificate)], [pem(root.certificate)]),
    ).rejects.toThrow(/Found invalid certificate in x5c/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('weist eine Kette eines fremden Ausstellers ohne Netzzugriff ab', async () => {
    const trusted = await createRoot('Trusted Issuer');
    const foreign = await createRoot('Foreign Issuer');
    const leaf = await issueCertificate(foreign, 'CN=Foreign Leaf');
    const fetchMock = stubCrlEndpoints({ [foreign.crlUrl]: () => createCrl(foreign) });

    await expect(
      validateCertificatePath([pem(leaf)], [pem(trusted.certificate)]),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({
        message: 'Certificate path did not terminate at the selected trust anchor',
      }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('weist ein Intermediate ab, das nicht vom freigegebenen Wurzelschlüssel signiert ist', async () => {
    const trusted = await createRoot('Same Name');
    const impostor = await createRoot('Same Name');
    const intermediate = await createIntermediate(impostor, 'Impostor');
    const leaf = await issueCertificate(intermediate, 'CN=Impostor Leaf');
    const fetchMock = stubCrlEndpoints({});

    await expect(
      validateCertificatePath(
        [pem(leaf), pem(intermediate.certificate)],
        [pem(trusted.certificate)],
      ),
    ).rejects.toMatchObject({ name: 'InvalidX5CChain' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('erkennt ein über die CRL seines Issuers gesperrtes Blattzertifikat', async () => {
    const root = await createRoot('Revoked Leaf');
    const intermediate = await createIntermediate(root, 'Revoked Leaf');
    const leaf = await issueCertificate(intermediate, 'CN=Revoked Leaf');
    stubCrlEndpoints({
      [intermediate.crlUrl]: () => createCrl(intermediate, { revoked: [leaf] }),
      [root.crlUrl]: () => createCrl(root),
    });

    await expect(
      validateCertificatePath([pem(leaf), pem(intermediate.certificate)], [pem(root.certificate)]),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({ message: 'Found revoked certificate in certificate path' }),
    });
  });

  it('erkennt ein über die CRL der Wurzel gesperrtes Intermediate', async () => {
    const root = await createRoot('Revoked Intermediate');
    const intermediate = await createIntermediate(root, 'Revoked Intermediate');
    const leaf = await issueCertificate(intermediate, 'CN=Leaf Under Revoked CA');
    stubCrlEndpoints({
      [intermediate.crlUrl]: () => createCrl(intermediate),
      [root.crlUrl]: () => createCrl(root, { revoked: [intermediate.certificate] }),
    });

    await expect(
      validateCertificatePath([pem(leaf), pem(intermediate.certificate)], [pem(root.certificate)]),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'Found revoked certificate in certificate path' }),
    });
  });

  it.each([
    ['Netzwerkfehler', () => Promise.reject(new TypeError('fetch failed'))],
    ['HTTP 404', () => new Response(null, { status: 404 })],
  ])('sperrt fail-closed bei %s des CRL-Abrufs', async (_case, respond) => {
    const root = await createRoot(`Unreachable ${_case}`);
    const leaf = await issueCertificate(root, 'CN=Unreachable CRL Leaf');
    stubCrlEndpoints({ [root.crlUrl]: respond });

    await expect(
      validateCertificatePath([pem(leaf)], [pem(root.certificate)]),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({
        message: 'Certificate revocation list could not be downloaded',
      }),
    });
  });

  it('sperrt fail-closed, wenn das Gesamtzeitlimit einen hängenden CRL-Abruf abbricht', async () => {
    const root = await createRoot('Hanging CRL');
    const leaf = await issueCertificate(root, 'CN=Hanging CRL Leaf');
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const pending = validateCertificatePath([pem(leaf)], [pem(root.certificate)], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('Zeitlimit erreicht'));

    await expect(pending).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({
        message: 'Certificate revocation list could not be downloaded',
        cause: expect.objectContaining({ message: 'Zeitlimit erreicht' }),
      }),
    });
  });

  it('verwirft eine nicht vom Issuer signierte CRL fail-closed', async () => {
    const root = await createRoot('Forged CRL');
    const leaf = await issueCertificate(root, 'CN=Forged CRL Leaf');
    const forger = await generateKeys();
    stubCrlEndpoints({ [root.crlUrl]: () => createCrl(root, { signingKey: forger.privateKey }) });

    await expect(
      validateCertificatePath([pem(leaf)], [pem(root.certificate)]),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: 'Certificate revocation list could not be verified',
        cause: expect.objectContaining({
          message: 'Certificate revocation list signature is invalid',
        }),
      }),
    });
  });

  it('verlangt mindestens eine Trust Anchor, statt die Prüfung zu überspringen', async () => {
    const root = await createRoot('No Anchor');
    const leaf = await issueCertificate(root, 'CN=No Anchor Leaf');
    const fetchMock = stubCrlEndpoints({});

    await expect(validateCertificatePath([pem(leaf)], [])).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      message: 'Certificate path has no trust anchor',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('begrenzt Kettenlänge und Anzahl der Trust Anchors vor jedem Parse- und Netzzugriff', async () => {
    const fetchMock = stubCrlEndpoints({});
    const message = 'Certificate path has an invalid number of certificates';

    await expect(validateCertificatePath([], ['anchor'])).rejects.toThrow(message);
    await expect(
      validateCertificatePath(
        Array.from({ length: 6 }, () => 'certificate'),
        ['anchor'],
      ),
    ).rejects.toThrow(message);
    await expect(
      validateCertificatePath(
        ['certificate'],
        Array.from({ length: 65 }, () => 'anchor'),
      ),
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wählt unter mehreren Trust Anchors diejenige, zu der die Kette führt', async () => {
    const unrelated = await createRoot('Unrelated Anchor');
    const root = await createRoot('Selected Anchor');
    const leaf = await issueCertificate(root, 'CN=Selected Anchor Leaf');
    stubCrlEndpoints({ [root.crlUrl]: () => createCrl(root) });

    await expect(
      validateCertificatePath([pem(leaf)], [pem(unrelated.certificate), pem(root.certificate)]),
    ).resolves.toBe(true);
  });

  it('verwirft abgelaufene Trust Anchors und weist ohne gültige Anchor ab', async () => {
    const expired = await createRoot('Expired Anchor', {
      notBefore: new Date(Date.now() - 2 * HOUR),
      notAfter: new Date(Date.now() - HOUR),
    });
    const leaf = await issueCertificate(expired, 'CN=Leaf Under Expired Anchor');
    const fetchMock = stubCrlEndpoints({});

    await expect(validateCertificatePath([pem(leaf)], [pem(expired.certificate)])).rejects.toThrow(
      'No specified trust anchor was valid for verifying x5c',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('isCertRevoked', () => {
  it('verlangt den tatsächlichen Issuer aus der Kette, bevor eine CRL geladen wird', async () => {
    const root = await createRoot('Issuer Required');
    const leaf = await issueCertificate(root, 'CN=Issuer Required Leaf');
    const fetchMock = stubCrlEndpoints({ [root.crlUrl]: () => createCrl(root) });

    await expect(isCertRevoked(leaf)).rejects.toThrow(
      'Certificate issuer is required to verify its revocation list',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(isCertRevoked(leaf, { issuer: root.certificate })).resolves.toBe(false);
  });
});
