// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// T-02: Attestationskette der Hardware-Registrierung mit echten Zertifikaten
// und CRLs: gültige Kette zur Statement-Wurzel, abgelaufenes Zertifikat,
// falscher Aussteller, Sperrung per CRL, CRL-Abruffehler und -Zeitlimit
// (fail-closed), Selbstbezug wie in SimpleWebAuthn sowie die AAGUID-Bindung.
// Den SSRF-geschützten CRL-Abruf (fetchCrl) ersetzt hier ein Durchreichen an
// den gestubbten globalen fetch; seinen Schutz belegt crl-fetch.test.ts.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/crypto/crl-fetch', () => ({
  fetchCrl: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));
import { Extension } from '@peculiar/x509';
import type { MetadataStatement } from '@simplewebauthn/server';
import {
  assertTrustedAttestationPath,
  extractAttestedAaguid,
  libraryAttestationStatement,
} from '../webauthn-attestation';
import {
  aaguidExtension,
  base64Der,
  createAttestationCertificate,
  createIntermediateCA,
  createRootCA,
  crlResponse,
  der,
  stubFetch,
} from './attestation-fixtures';

const HOUR = 3_600_000;
const AAGUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_AAGUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertTrustedAttestationPath', () => {
  it('akzeptiert eine Kette zur Statement-Wurzel und lädt die CRL mit dem Zeitlimit-Signal', async () => {
    const root = await createRootCA('Attestation Valid');
    const leaf = await createAttestationCertificate(root);
    const fetchMock = stubFetch({ [root.crlUrl]: () => crlResponse(root) });
    const controller = new AbortController();

    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        // MDS liefert die Wurzeln als Base64-DER.
        attestationRootCertificates: [base64Der(root.certificate)],
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(root.crlUrl, {
      signal: controller.signal,
      redirect: 'error',
    });
  });

  it('akzeptiert Blatt → Intermediate → Wurzel und prüft beide Sperrlisten', async () => {
    const root = await createRootCA('Attestation Two Level');
    const intermediate = await createIntermediateCA(root, 'Attestation Two Level');
    const leaf = await createAttestationCertificate(intermediate);
    const fetchMock = stubFetch({
      [intermediate.crlUrl]: () => crlResponse(intermediate),
      [root.crlUrl]: () => crlResponse(root),
    });

    await assertTrustedAttestationPath({
      certificateChain: [der(leaf), der(intermediate.certificate)],
      attestationRootCertificates: [base64Der(root.certificate)],
      signal: new AbortController().signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('übernimmt nur den Selbstbezug aus SimpleWebAuthn: ein einzelnes Zertifikat, das selbst Statement-Wurzel ist', async () => {
    const root = await createRootCA('Self Referencing');
    const leaf = await createAttestationCertificate(root);
    const fetchMock = stubFetch({});

    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        attestationRootCertificates: [base64Der(root.certificate), base64Der(leaf)],
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    // Mit zusätzlichem Zertifikat gilt der Selbstbezug nicht mehr.
    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf), der(root.certificate)],
        attestationRootCertificates: [base64Der(leaf)],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'InvalidX5CChain' });
  });

  it('weist eine Kette unter einem fremden Aussteller ohne Netzzugriff ab', async () => {
    const trusted = await createRootCA('Attestation Trusted');
    const foreign = await createRootCA('Attestation Foreign');
    const leaf = await createAttestationCertificate(foreign);
    const fetchMock = stubFetch({ [foreign.crlUrl]: () => crlResponse(foreign) });

    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        attestationRootCertificates: [base64Der(trusted.certificate)],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'InvalidX5CChain' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('weist ein abgelaufenes Attestationszertifikat ohne Netzzugriff ab', async () => {
    const root = await createRootCA('Attestation Expired');
    const leaf = await createAttestationCertificate(root, {
      notBefore: new Date(Date.now() - 2 * HOUR),
      notAfter: new Date(Date.now() - HOUR),
    });
    const fetchMock = stubFetch({ [root.crlUrl]: () => crlResponse(root) });

    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        attestationRootCertificates: [base64Der(root.certificate)],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Found invalid certificate in x5c/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('erkennt ein per CRL gesperrtes Attestationszertifikat', async () => {
    const root = await createRootCA('Attestation Revoked');
    const leaf = await createAttestationCertificate(root);
    stubFetch({ [root.crlUrl]: () => crlResponse(root, [leaf]) });

    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        attestationRootCertificates: [base64Der(root.certificate)],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: 'InvalidX5CChain',
      cause: expect.objectContaining({ message: 'Found revoked certificate in certificate path' }),
    });
  });

  it('sperrt fail-closed, wenn die CRL nicht abrufbar ist', async () => {
    const root = await createRootCA('Attestation Unreachable');
    const leaf = await createAttestationCertificate(root);
    stubFetch({});

    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        attestationRootCertificates: [base64Der(root.certificate)],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: 'Certificate revocation list could not be downloaded',
      }),
    });
  });

  it('sperrt fail-closed, sobald das Zeitlimit einen hängenden CRL-Abruf abbricht', async () => {
    const root = await createRootCA('Attestation Hanging');
    const leaf = await createAttestationCertificate(root);
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

    const pending = assertTrustedAttestationPath({
      certificateChain: [der(leaf)],
      attestationRootCertificates: [base64Der(root.certificate)],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('Zeitlimit der Hardware-Attestationsprüfung überschritten'));

    await expect(pending).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: 'Certificate revocation list could not be downloaded',
      }),
    });
  });

  it('weist ohne Statement-Wurzel ab, statt die Kettenprüfung zu überspringen', async () => {
    const root = await createRootCA('Attestation Without Root');
    const leaf = await createAttestationCertificate(root);
    const fetchMock = stubFetch({});

    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        attestationRootCertificates: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Certificate path has no trust anchor');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractAttestedAaguid', () => {
  it('liest die nichtkritische FIDO-AAGUID aus einem echten Attestationszertifikat', async () => {
    const root = await createRootCA('AAGUID Present');
    const leaf = await createAttestationCertificate(root, { aaguid: AAGUID });

    expect(extractAttestedAaguid(leaf)).toBe(AAGUID);
  });

  it('macht eine abweichende Modell-AAGUID unter gemeinsamer Wurzel erkennbar', async () => {
    const root = await createRootCA('AAGUID Mismatch');
    const leaf = await createAttestationCertificate(root, { aaguid: OTHER_AAGUID });

    // webauthn-verification.ts vergleicht dies vor jedem Netzzugriff mit der signierten AAGUID.
    expect(extractAttestedAaguid(leaf)).toBe(OTHER_AAGUID);
    expect(extractAttestedAaguid(leaf)).not.toBe(AAGUID);
  });

  it.each([
    ['fehlende', null, /bindet seine AAGUID nicht/],
    ['kritische', aaguidExtension(AAGUID, true), /bindet seine AAGUID nicht/],
  ])('weist eine %s AAGUID-Extension ab', async (_case, extension, message) => {
    const root = await createRootCA(`AAGUID ${_case}`);
    const leaf = await createAttestationCertificate(root, { aaguidExtension: extension });

    expect(() => extractAttestedAaguid(leaf)).toThrow(message);
  });

  it('weist eine nicht exakt 16 Byte lange AAGUID ab', async () => {
    const root = await createRootCA('AAGUID Length');
    const leaf = await createAttestationCertificate(root, {
      aaguidExtension: new Extension(
        '1.3.6.1.4.1.45724.1.1.4',
        false,
        new Uint8Array([0x04, 0x0f, ...new Uint8Array(15).fill(0xaa)]),
      ),
    });

    expect(() => extractAttestedAaguid(leaf)).toThrow(/attestierte AAGUID .* ist ungültig/);
  });
});

describe('libraryAttestationStatement', () => {
  it('entzieht der Bibliothekskopie nur die Wurzeln und lässt das gespeicherte Statement unverändert', () => {
    const statement = {
      aaguid: AAGUID,
      attestationRootCertificates: ['root'],
      attestationTypes: ['basic_full'],
      authenticationAlgorithms: ['secp256r1_ecdsa_sha256_raw'],
    } as unknown as MetadataStatement;

    expect(libraryAttestationStatement(statement)).toEqual({
      ...statement,
      attestationRootCertificates: [],
    });
    expect(statement.attestationRootCertificates).toEqual(['root']);
  });
});
