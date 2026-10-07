// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// T-02: Vertrag mit dem ungepatchten @simplewebauthn/server 13.3.3 (ohne
// Mocks, echte packed-Attestation). Belegt, worauf die eigene Kettenprüfung
// (webauthn-attestation.ts) aufbaut:
//   - Ohne Statement-Wurzeln verifiziert die Bibliothek Challenge, Origin,
//     RP-ID, Flags, Algorithmen und Attestationssignatur ohne Netzzugriff.
//   - Sie verifiziert dann auch eine fremde Kette; die eigene Prüfung ist
//     deshalb verbindlich und weist sie ab.
//   - Mit Statement-Wurzeln lädt sie CRLs selbst: schon die CRL-URL eines
//     nicht vertrauenswürdigen Zertifikats vor dem Kettenaufbau, ohne
//     Redirect-Sperre und fail-open bei Abruffehlern.
// Schlägt ein Fall nach einem Upgrade fehl, hat sich das Upstream-Verhalten
// geändert: Wurzelentzug und Vorprüfung neu bewerten (docs/development/
// simplewebauthn-upstream.md). Der SSRF-geschützte CRL-Abruf der eigenen
// Prüfung (fetchCrl) reicht hier an denselben gestubbten globalen fetch durch,
// den auch die Bibliothek nutzt; seinen Schutz belegt crl-fetch.test.ts.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/crypto/crl-fetch', () => ({
  fetchCrl: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));
import {
  MetadataService,
  verifyRegistrationResponse,
  type MetadataStatement,
} from '@simplewebauthn/server';
import { assertTrustedAttestationPath, libraryAttestationStatement } from '../webauthn-attestation';
import {
  CHALLENGE,
  ORIGIN,
  RP_ID,
  base64Der,
  createAttestationCertificate,
  createRootCA,
  crlResponse,
  der,
  generateKeys,
  packedRegistrationResponse,
  stubFetch,
  type Authority,
} from './attestation-fixtures';

const AAGUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function statementFor(root: Authority): MetadataStatement {
  return {
    aaguid: AAGUID,
    description: 'Testschlüssel',
    authenticatorVersion: 42,
    protocolFamily: 'fido2',
    schema: 3,
    upv: [{ major: 1, minor: 0 }],
    authenticationAlgorithms: ['secp256r1_ecdsa_sha256_raw'],
    publicKeyAlgAndEncodings: ['cose'],
    attestationTypes: ['basic_full'],
    userVerificationDetails: [[{ userVerificationMethod: 'presence_internal' }]],
    keyProtection: ['hardware', 'secure_element'],
    matcherProtection: ['on_chip'],
    attachmentHint: ['external', 'wired'],
    tcDisplay: [],
    attestationRootCertificates: [base64Der(root.certificate)],
  } as unknown as MetadataStatement;
}

async function registration(root: Authority, issuer: Authority = root) {
  const attestationKeys = await generateKeys();
  const leaf = await createAttestationCertificate(issuer, {
    aaguid: AAGUID,
    publicKey: attestationKeys.publicKey,
  });
  const response = await packedRegistrationResponse({
    aaguid: AAGUID,
    attestationKeys,
    certificateChain: [leaf],
  });
  return { leaf, response };
}

function verify(response: Awaited<ReturnType<typeof registration>>['response']) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserPresence: true,
    requireUserVerification: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T-02: SimpleWebAuthn 13.3.3 ohne Patch', () => {
  it('verifiziert eine echte packed-Attestation ohne Netzzugriff, wenn das Statement keine Wurzeln trägt', async () => {
    const root = await createRootCA('Contract Valid');
    const { leaf, response } = await registration(root);
    const statement = statementFor(root);
    await MetadataService.initialize({
      mdsServers: [],
      statements: [libraryAttestationStatement(statement)],
      verificationMode: 'strict',
    });
    const libraryFetch = stubFetch({});

    const result = await verify(response);
    expect(result).toMatchObject({
      verified: true,
      registrationInfo: { fmt: 'packed', aaguid: AAGUID, userVerified: true },
    });
    expect(libraryFetch).not.toHaveBeenCalled();

    // Die eigene Prüfung lädt danach die CRL gehärtet und akzeptiert die Kette.
    const pathFetch = stubFetch({ [root.crlUrl]: () => crlResponse(root) });
    const controller = new AbortController();
    await assertTrustedAttestationPath({
      certificateChain: [der(leaf)],
      attestationRootCertificates: statement.attestationRootCertificates,
      signal: controller.signal,
    });
    expect(pathFetch.mock.calls).toEqual([
      [root.crlUrl, { signal: controller.signal, redirect: 'error' }],
    ]);
  });

  it('verifiziert ohne Wurzeln auch eine fremde Kette – die eigene Kettenprüfung weist sie ab', async () => {
    const trusted = await createRootCA('Contract Trusted');
    const foreign = await createRootCA('Contract Foreign');
    const { leaf, response } = await registration(trusted, foreign);
    const statement = statementFor(trusted);
    await MetadataService.initialize({
      mdsServers: [],
      statements: [libraryAttestationStatement(statement)],
      verificationMode: 'strict',
    });
    const fetchMock = stubFetch({});

    await expect(verify(response)).resolves.toMatchObject({ verified: true });
    await expect(
      assertTrustedAttestationPath({
        certificateChain: [der(leaf)],
        attestationRootCertificates: statement.attestationRootCertificates,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'InvalidX5CChain' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lädt mit Statement-Wurzeln die CRL eines fremden Zertifikats schon vor dem Kettenaufbau', async () => {
    const trusted = await createRootCA('Contract Upstream Order');
    const foreign = await createRootCA('Contract Upstream Foreign');
    const { response } = await registration(trusted, foreign);
    await MetadataService.initialize({
      mdsServers: [],
      statements: [statementFor(trusted)],
      verificationMode: 'strict',
    });
    const fetchMock = stubFetch({});

    await expect(verify(response)).rejects.toThrow(/certificate path/i);
    // Zertifikatsgesteuerte URL, ohne Abbruchsignal und Redirect-Sperre abgerufen.
    expect(fetchMock).toHaveBeenCalledWith(foreign.crlUrl);
  });

  it('akzeptiert mit Statement-Wurzeln eine Kette trotz unerreichbarer CRL (fail-open)', async () => {
    const root = await createRootCA('Contract Fail Open');
    const { response } = await registration(root);
    await MetadataService.initialize({
      mdsServers: [],
      statements: [statementFor(root)],
      verificationMode: 'strict',
    });
    const fetchMock = stubFetch({});

    await expect(verify(response)).resolves.toMatchObject({ verified: true });
    expect(fetchMock).toHaveBeenCalledWith(root.crlUrl);
  });
});
