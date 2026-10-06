// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-TENANT-RLS-001
// P-23: Die Hardware-Vorgänge lesen ausschließlich den gespeicherten,
// signaturgeprüften FIDO-MDS-Snapshot im Anker fido_mds_trust_state.
// Download und Signaturprüfung des BLOBs testet der Worker-Job
// fido-mds-refresh.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  metadataInitialize: vi.fn(),
  metadataGetStatement: vi.fn(),
  verifyMDSBlob: vi.fn(),
  // T-02: eigene Ketten- und CRL-Prüfung (webauthn-attestation.ts).
  assertTrustedAttestationPath: vi.fn(async (_input: unknown) => undefined),
  fetch: vi.fn(),
  decodeAttestationObject: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
  evidenceRecord: vi.fn(),
  credentialFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  prismaQueryRaw: vi.fn(),
  logWarn: vi.fn(),
  hardwareAaguids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  hardwarePolicyRevision: 1,
  firmwareExtensionValue: new Uint8Array([0x02, 0x01, 0x2a]) as Uint8Array | undefined,
  firmwareExtensionCritical: false,
  aaguidExtensionValue: new Uint8Array([
    0x04, 0x10, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x4a, 0xaa, 0x8a, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa,
  ]) as Uint8Array | undefined,
  aaguidExtensionCritical: false,
  certificateError: null as Error | null,
  // Persistenter Vertrauensstand, wie ihn der Worker-Job hinterlegt.
  trust: {
    blobSerial: 7n,
    nextUpdate: '2099-01-01',
    verifiedAt: new Date(),
    policyRevision: 0n,
    policyHash: '0'.repeat(64),
  },
  snapshots: new Map<bigint, { sha256: string; entries: unknown }>(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
  MetadataService: {
    initialize: mocks.metadataInitialize,
    getStatement: mocks.metadataGetStatement,
  },
}));
vi.mock('@simplewebauthn/server/helpers', () => ({
  decodeAttestationObject: mocks.decodeAttestationObject,
  verifyMDSBlob: mocks.verifyMDSBlob,
}));
vi.mock('@peculiar/x509', () => {
  // Nur Attestationszertifikate: die MDS-Signer-Prüfung liegt im Worker-Job.
  class X509Certificate {
    getExtension(type: string) {
      if (mocks.certificateError) throw mocks.certificateError;
      const value =
        type === '1.3.6.1.4.1.45724.1.1.4'
          ? mocks.aaguidExtensionValue
          : type === '1.3.6.1.4.1.45724.1.1.5'
            ? mocks.firmwareExtensionValue
            : undefined;
      if (!value) return null;
      return {
        critical:
          type === '1.3.6.1.4.1.45724.1.1.4'
            ? mocks.aaguidExtensionCritical
            : mocks.firmwareExtensionCritical,
        value: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      };
    }
  }
  return { X509Certificate };
});
vi.mock('@taxtronik/config', () => ({
  env: {
    NEXTAUTH_URL: 'https://kanzlei.example.test',
    NODE_ENV: 'test',
    WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: mocks.hardwareAaguids,
    get WEBAUTHN_HARDWARE_POLICY_REVISION() {
      return mocks.hardwarePolicyRevision;
    },
  },
}));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({ set: mocks.redisSet, eval: mocks.redisEval }),
}));
vi.mock('@/server/container', () => ({
  evidenceService: { record: mocks.evidenceRecord },
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    staffWebAuthnCredential: { findUnique: mocks.credentialFindUnique },
    $transaction: mocks.prismaTransaction,
    $queryRaw: mocks.prismaQueryRaw,
  },
}));
vi.mock('@/server/logger', () => ({ log: { warn: mocks.logWarn } }));
vi.mock('../login-audit', () => ({ auditIp: (ip: string | null) => ip }));
// T-02: Nur die netzwerkgebundene Kettenprüfung wird ersetzt; AAGUID-Bindung
// und Statement-Kopie laufen echt (Kettenfälle: webauthn-attestation.test.ts).
vi.mock('../webauthn-attestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webauthn-attestation')>()),
  assertTrustedAttestationPath: mocks.assertTrustedAttestationPath,
}));

import { env } from '@taxtronik/config';
import {
  assertStoredHardwareCredentialTrusted,
  beginHardwareLogin,
  beginHardwareModeAssertion,
  beginHardwareRegistration,
  consumeHardwareCeremony,
  HardwareAccessUnavailableError,
  HardwareAccessVerificationError,
  authenticateStaffHardwareCredential,
  initializeHardwareAccessPolicy,
  isAuthenticationResponse,
  isHardwareAccessConfigured,
  isRegistrationResponse,
  lockMatchingHardwareMetadataSerial,
  parseAuthenticationResponse,
  resetHardwareMetadataCacheForTests,
  type HardwareCeremony,
  verifyHardwareAssertion,
  verifyHardwareRegistration,
} from '../webauthn';

const mutableEnv = env as unknown as { NODE_ENV: string; NEXTAUTH_URL: string };

const CEREMONY_ID = 'a'.repeat(32);
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const USER_HANDLE = Buffer.from(STAFF_ID, 'utf8').toString('base64url');
const HARDWARE_AAGUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REJECTED_HARDWARE_AAGUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function trustedMetadataStatement() {
  return {
    aaguid: HARDWARE_AAGUID,
    authenticatorVersion: 40,
    attestationRootCertificates: ['trusted-root'],
    attestationTypes: ['basic_full'],
    keyProtection: ['hardware', 'secure_element'],
    attachmentHint: ['external', 'wired'],
    authenticatorGetInfo: { options: { plat: false } },
  };
}

const metadataEntry = {
  aaguid: HARDWARE_AAGUID,
  metadataStatement: trustedMetadataStatement(),
  statusReports: [
    { status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-01-01', authenticatorVersion: 40 },
  ],
  timeOfLastStatusChange: '2020-01-01',
};

function setMetadataStatus(statuses: string[]): void {
  setMetadataReports(
    statuses.map((status) => ({
      status,
      effectiveDate: '2020-01-01',
      authenticatorVersion: 40,
    })),
  );
}

function setMetadataReports(
  reports: Array<{
    status: string;
    effectiveDate?: string;
    sunsetDate?: string;
    authenticatorVersion?: number;
  }>,
): void {
  const statement = trustedMetadataStatement();
  Object.assign(metadataEntry, {
    aaguid: HARDWARE_AAGUID,
    metadataStatement: statement,
    statusReports: reports,
    timeOfLastStatusChange: '2020-01-01',
  });
  // SimpleWebAuthn erhält das Statement ohne Wurzeln (T-02).
  mocks.metadataGetStatement.mockResolvedValue({ ...statement, attestationRootCertificates: [] });
}

function ceremony(purpose: HardwareCeremony['purpose'] = 'login'): HardwareCeremony {
  return {
    version: 1,
    purpose,
    challenge: 'challenge-value',
    origin: 'https://kanzlei.example.test',
    rpID: 'kanzlei.example.test',
    ...(purpose === 'login'
      ? {}
      : {
          staffId: STAFF_ID,
          tenantId: '11111111-1111-4111-8111-111111111111',
        }),
  };
}

function registrationResponse(
  transports: RegistrationResponseJSON['response']['transports'] = ['usb'],
  attachment: RegistrationResponseJSON['authenticatorAttachment'] = 'cross-platform',
): RegistrationResponseJSON {
  return {
    id: 'credential-id-long-enough',
    rawId: 'credential-id-long-enough',
    type: 'public-key',
    authenticatorAttachment: attachment,
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'client-data',
      attestationObject: 'attestation-object',
      transports,
    },
  };
}

function authenticationResponse(userHandle = USER_HANDLE): AuthenticationResponseJSON {
  return {
    id: 'credential-id-long-enough',
    rawId: 'credential-id-long-enough',
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'client-data',
      authenticatorData: 'authenticator-data',
      signature: 'signature',
      userHandle,
    },
  };
}

function encodedFirmwareVersion(version: number): Uint8Array {
  const octets: number[] = [];
  let remaining = version;
  do {
    octets.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  if ((octets[0]! & 0x80) !== 0) octets.unshift(0);
  return new Uint8Array([0x02, octets.length, ...octets]);
}

function currentPolicyHash(): string {
  const enabled =
    mocks.hardwareAaguids.length > 0 &&
    !mocks.hardwareAaguids.includes('00000000-0000-0000-0000-000000000000');
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        enabled,
        aaguids: enabled ? [...mocks.hardwareAaguids].sort() : [],
      }),
      'utf8',
    )
    .digest('hex');
}

const SNAPSHOT_SHA256 = 'f'.repeat(64);

/** Snapshot-Einträge des Ankers (nur freigegebene AAGUIDs). */
function isSnapshotEntriesQuery(sql: string): boolean {
  return sql.includes('jsonb_array_elements(trust_state."snapshot_entries")');
}

/** Anker samt Prüfsumme des zur Serie passenden Snapshots. */
function isTrustStateQuery(sql: string): boolean {
  return sql.includes('AS trust_state') && !isSnapshotEntriesQuery(sql);
}

/** Gespeicherter Vertrauensstand (Owner-Tabelle) als zustandsbehaftete Attrappe. */
function storedTrustStateQuery(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.join(' ');
  if (sql.includes('INSERT INTO public."fido_mds_trust_state"')) {
    const revision = values.find((value): value is bigint => typeof value === 'bigint')!;
    const hash = values.find(
      (value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    )!;
    if (
      mocks.trust.policyRevision < revision ||
      (mocks.trust.policyRevision === revision && mocks.trust.policyHash === hash)
    ) {
      mocks.trust.policyRevision = revision;
      mocks.trust.policyHash = hash;
      return Promise.resolve([{ policy_revision: revision, policy_hash: hash }]);
    }
    return Promise.resolve([]);
  }
  if (isSnapshotEntriesQuery(sql)) {
    // Wie die SQL-Abfrage: nur Einträge der angefragten AAGUIDs (LEFT JOIN →
    // eine Zeile ohne Eintrag, wenn keine AAGUID passt).
    const [aaguids, serial] = values as [string[], bigint];
    const snapshot = mocks.snapshots.get(serial);
    if (!snapshot) return Promise.resolve([]);
    const matching = (snapshot.entries as Array<{ aaguid?: unknown }>).filter(
      (entry) => typeof entry?.aaguid === 'string' && aaguids.includes(entry.aaguid.toLowerCase()),
    );
    return Promise.resolve(
      matching.length === 0
        ? [{ blob_sha256: snapshot.sha256, entry: null }]
        : matching.map((entry) => ({ blob_sha256: snapshot.sha256, entry })),
    );
  }
  if (isTrustStateQuery(sql)) {
    return Promise.resolve([
      {
        blob_serial: mocks.trust.blobSerial,
        next_update: mocks.trust.nextUpdate,
        verified_at: mocks.trust.verifiedAt,
        policy_revision: mocks.trust.policyRevision,
        policy_hash: mocks.trust.policyHash,
        snapshot_sha256: mocks.snapshots.get(mocks.trust.blobSerial)?.sha256 ?? null,
      },
    ]);
  }
  return Promise.reject(new Error(`unerwartete Testabfrage: ${sql}`));
}

function snapshotReads(): number {
  return mocks.prismaQueryRaw.mock.calls.filter(([strings]) =>
    isSnapshotEntriesQuery((strings as TemplateStringsArray).join(' ')),
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHardwareMetadataCacheForTests();
  mocks.hardwareAaguids.splice(0, Infinity, HARDWARE_AAGUID);
  mocks.hardwarePolicyRevision = 1;
  mocks.firmwareExtensionValue = new Uint8Array([0x02, 0x01, 0x2a]);
  mocks.firmwareExtensionCritical = false;
  mocks.aaguidExtensionValue = new Uint8Array([
    0x04, 0x10, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x4a, 0xaa, 0x8a, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa,
  ]);
  mocks.aaguidExtensionCritical = false;
  mocks.certificateError = null;
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.redisSet.mockResolvedValue('OK');
  mocks.prismaTransaction.mockImplementation(async (callback: (tx: object) => unknown) =>
    callback({}),
  );
  mocks.metadataInitialize.mockResolvedValue(undefined);
  setMetadataStatus(['FIDO_CERTIFIED_L2']);
  // P-23: Jeder Netzzugriff aus einem Hardware-Vorgang wäre ein Fehler.
  mocks.fetch.mockRejectedValue(new Error('kein MDS-Abruf im Request erlaubt'));
  Object.assign(mocks.trust, {
    blobSerial: 7n,
    nextUpdate: '2099-01-01',
    verifiedAt: new Date(),
    policyRevision: 0n,
    policyHash: '0'.repeat(64),
  });
  mocks.snapshots.clear();
  mocks.snapshots.set(7n, { sha256: SNAPSHOT_SHA256, entries: [metadataEntry] });
  mocks.prismaQueryRaw.mockReset();
  mocks.prismaQueryRaw.mockImplementation(storedTrustStateQuery);
  mocks.decodeAttestationObject.mockReturnValue({
    get: (key: string) =>
      key === 'fmt'
        ? 'packed'
        : key === 'attStmt'
          ? {
              get: (statementKey: string) =>
                statementKey === 'x5c' ? [new Uint8Array([1])] : undefined,
            }
          : new Uint8Array([1]),
  });
  mocks.generateAuthenticationOptions.mockResolvedValue({
    challenge: 'challenge-value',
    rpId: 'kanzlei.example.test',
    userVerification: 'required',
  });
  mocks.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      fmt: 'packed',
      aaguid: HARDWARE_AAGUID,
      credential: {
        id: 'credential-id-long-enough',
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
      },
      userVerified: true,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      attestationObject: new Uint8Array([1, 2, 3]),
    },
  });
  mocks.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: {
      newCounter: 7,
      userVerified: true,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    },
  });
});

describe('WebAuthn-Challenge-Speicher', () => {
  it('bindet eine usernameless Login-Challenge fünf Minuten und einmalig an RP und Origin', async () => {
    const result = await beginHardwareLogin();

    expect(result.options).toEqual(
      expect.objectContaining({ challenge: 'challenge-value', userVerification: 'required' }),
    );
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'kanzlei.example.test',
      timeout: 60_000,
      userVerification: 'required',
    });
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    const [key, serialized, ex, ttl, nx] = mocks.redisSet.mock.calls[0]!;
    expect(key).toMatch(/^staff-webauthn:ceremony:[A-Za-z0-9_-]{32}$/);
    expect({ ex, ttl, nx }).toEqual({ ex: 'EX', ttl: 300, nx: 'NX' });
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      purpose: 'login',
      challenge: 'challenge-value',
      origin: 'https://kanzlei.example.test',
      rpID: 'kanzlei.example.test',
    });
  });

  it('verbraucht die Challenge atomar und lehnt Replay oder Zweckwechsel ab', async () => {
    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony())).mockResolvedValueOnce(null);

    await expect(
      consumeHardwareCeremony({ ceremonyId: CEREMONY_ID, purpose: 'login' }),
    ).resolves.toMatchObject({ purpose: 'login', challenge: 'challenge-value' });
    await expect(
      consumeHardwareCeremony({ ceremonyId: CEREMONY_ID, purpose: 'login' }),
    ).rejects.toBeInstanceOf(HardwareAccessVerificationError);

    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony('register')));
    await expect(
      consumeHardwareCeremony({ ceremonyId: CEREMONY_ID, purpose: 'login' }),
    ).rejects.toThrow(/passt nicht/i);
  });

  it('bindet eine administrative Step-up-Assertion an Akteur, Ziel und Auth-Revision', async () => {
    await beginHardwareModeAssertion({
      purpose: 'admin-recovery',
      staffId: STAFF_ID,
      tenantId: '11111111-1111-4111-8111-111111111111',
      targetStaffId: '33333333-3333-4333-8333-333333333333',
      authRevision: 4,
      credentials: [{ credentialId: 'credential-id-long-enough', transports: ['usb'] }],
    });

    const serialized = mocks.redisSet.mock.calls[0]![1];
    expect(JSON.parse(serialized)).toEqual(
      expect.objectContaining({
        purpose: 'admin-recovery',
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        targetStaffId: '33333333-3333-4333-8333-333333333333',
        authRevision: 4,
      }),
    );
  });
});

describe('Policy für physische Sicherheitsschlüssel', () => {
  it('verankert auch ein globales Disable, bevor WebAuthn lokal abgewiesen wird', async () => {
    mocks.hardwareAaguids.splice(0);
    mocks.hardwarePolicyRevision = 2;

    await expect(initializeHardwareAccessPolicy()).resolves.toBeUndefined();

    const updateCall = mocks.prismaQueryRaw.mock.calls.find(([strings]) =>
      strings.join(' ').includes("TIMESTAMPTZ '1970-01-01 00:00:00+00'"),
    );
    expect(updateCall?.slice(1)).toContain(2n);
    expect(updateCall?.slice(1)).toContain(currentPolicyHash());
    expect(mocks.fetch).not.toHaveBeenCalled();

    await expect(beginHardwareLogin()).rejects.toThrow(/zentral deaktiviert/i);
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('erzwingt bei Allowlist-Wechsel eine höhere Policy-Revision und sperrt alte Replicas aus', async () => {
    const initialHash = currentPolicyHash();
    const state = { policyRevision: 1n, policyHash: initialHash };
    mocks.prismaQueryRaw.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(' ');
        if (!sql.includes("TIMESTAMPTZ '1970-01-01 00:00:00+00'")) {
          throw new Error(`unerwartete Testabfrage: ${sql}`);
        }
        const revision = values.find((value): value is bigint => typeof value === 'bigint')!;
        const hash = values.find(
          (value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
        )!;
        if (
          state.policyRevision < revision ||
          (state.policyRevision === revision && state.policyHash === hash)
        ) {
          state.policyRevision = revision;
          state.policyHash = hash;
          return Promise.resolve([{ policy_revision: revision, policy_hash: hash }]);
        }
        return Promise.resolve([]);
      },
    );

    await expect(initializeHardwareAccessPolicy()).resolves.toBeUndefined();
    mocks.hardwareAaguids.push(REJECTED_HARDWARE_AAGUID);
    await expect(initializeHardwareAccessPolicy()).rejects.toThrow(/Policy.*nicht neuer/i);

    mocks.hardwarePolicyRevision = 2;
    await expect(initializeHardwareAccessPolicy()).resolves.toBeUndefined();
    expect(state).toEqual({ policyRevision: 2n, policyHash: currentPolicyHash() });

    mocks.hardwarePolicyRevision = 1;
    mocks.hardwareAaguids.splice(0, Infinity, HARDWARE_AAGUID);
    await expect(initializeHardwareAccessPolicy()).rejects.toThrow(/Policy.*nicht neuer/i);
    const claimSql = mocks.prismaQueryRaw.mock.calls[0]?.[0].join(' ');
    expect(claimSql).toContain('"policy_revision" < EXCLUDED."policy_revision"');
  });

  it('bindet den Commit an die exakt verifizierte MDS-Seriennummer', async () => {
    const matchingTx = { $queryRaw: vi.fn().mockResolvedValue([{ matches: true }]) };
    await expect(
      lockMatchingHardwareMetadataSerial(matchingTx as never, 7n),
    ).resolves.toBeUndefined();
    expect(matchingTx.$queryRaw.mock.calls[0]?.[0].join(' ')).toContain(
      'app.lock_matching_fido_mds_state',
    );
    expect(matchingTx.$queryRaw.mock.calls[0]?.slice(1)).toEqual([7n, 1n, currentPolicyHash()]);

    const staleTx = { $queryRaw: vi.fn().mockResolvedValue([{ matches: false }]) };
    await expect(lockMatchingHardwareMetadataSerial(staleTx as never, 7n)).rejects.toThrow(
      /FIDO-Vertrauensstand wurde zwischenzeitlich aktualisiert/i,
    );
  });

  it('fordert direkte Attestation und prüft vor dem Enrollment die freigegebene MDS-Modellfamilie', async () => {
    mocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'registration-challenge' });

    await beginHardwareRegistration({
      staffId: STAFF_ID,
      tenantId: '11111111-1111-4111-8111-111111111111',
      authRevision: 4,
      email: 'staff@example.test',
      fullName: 'Staff Test',
      existingCredentials: [],
    });

    // P-23: kein MDS-Abruf im Request, nur der gespeicherte Snapshot.
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
    expect(snapshotReads()).toBe(1);
    // T-02: Ohne Wurzeln baut SimpleWebAuthn keine eigene Kette und lädt keine CRL.
    expect(mocks.metadataInitialize).toHaveBeenCalledWith({
      mdsServers: [],
      statements: [{ ...metadataEntry.metadataStatement, attestationRootCertificates: [] }],
      verificationMode: 'strict',
    });
    expect(metadataEntry.metadataStatement.attestationRootCertificates).toEqual(['trusted-root']);
    expect(mocks.metadataGetStatement).toHaveBeenCalledWith(HARDWARE_AAGUID);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        attestationType: 'direct',
        preferredAuthenticatorType: 'securityKey',
        authenticatorSelection: expect.objectContaining({
          authenticatorAttachment: 'cross-platform',
          residentKey: 'required',
          userVerification: 'required',
        }),
      }),
    );
    expect(JSON.parse(mocks.redisSet.mock.calls[0]![1])).toEqual(
      expect.objectContaining({
        purpose: 'register',
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
      }),
    );
  });

  it('akzeptiert nur verifizierte, gerätegebundene und nicht gesicherte Hardware-Transporte', async () => {
    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(['usb', 'nfc']),
        ceremony: ceremony('register'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        credentialId: 'credential-id-long-enough',
        signCount: 0n,
        transports: ['usb', 'nfc'],
        deviceType: 'singleDevice',
        backedUp: false,
        attestationFormat: 'packed',
        attestationVerifiedAt: expect.any(Date),
        authenticatorVersion: 42n,
        metadataSerial: 7n,
      }),
    );

    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(['internal'], 'platform'),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/physischen FIDO2-Sicherheitsschlüssel/i);

    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(['usb', 'hybrid']),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/nicht als physischer Sicherheitsschlüssel/i);
  });

  it.each([
    ['fehlende', undefined, false, /bindet seine AAGUID nicht/i],
    [
      'kritische',
      new Uint8Array([
        0x04, 0x10, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x4a, 0xaa, 0x8a, 0xaa, 0xaa, 0xaa, 0xaa,
        0xaa, 0xaa, 0xaa,
      ]),
      true,
      /bindet seine AAGUID nicht/i,
    ],
    [
      'abweichende',
      new Uint8Array([
        0x04, 0x10, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0x4b, 0xbb, 0x8b, 0xbb, 0xbb, 0xbb, 0xbb,
        0xbb, 0xbb, 0xbb,
      ]),
      false,
      /passt nicht/i,
    ],
  ])(
    'lehnt eine %s Zertifikat-AAGUID ab',
    async (_case, extensionValue, critical, expectedMessage) => {
      mocks.aaguidExtensionValue = extensionValue;
      mocks.aaguidExtensionCritical = critical;

      await expect(
        verifyHardwareRegistration({
          response: registrationResponse(),
          ceremony: ceremony('register'),
        }),
      ).rejects.toThrow(expectedMessage);
      // T-02: AAGUID-Bindung vor jedem CRL-Netzzugriff der Kettenprüfung.
      expect(mocks.assertTrustedAttestationPath).not.toHaveBeenCalled();
    },
  );

  it('begrenzt die Registration-Antwort vor MDS- und Attestationsprüfung', async () => {
    const response = registrationResponse();
    response.response.attestationObject = 'a'.repeat(512 * 1024 + 1);

    await expect(
      verifyHardwareRegistration({ response, ceremony: ceremony('register') }),
    ).rejects.toThrow(/zu groß oder ungültig/i);
    expect(mocks.prismaQueryRaw).not.toHaveBeenCalled();
    expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('begrenzt x5c auf fünf Zertifikate vor jedem Netzzugriff', async () => {
    mocks.decodeAttestationObject.mockReturnValueOnce({
      get: (key: string) =>
        key === 'fmt'
          ? 'packed'
          : key === 'attStmt'
            ? { get: () => Array.from({ length: 6 }, () => new Uint8Array([1])) }
            : new Uint8Array([1]),
    });

    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/vollständige.*Hardware-Attestation/i);
    expect(mocks.prismaQueryRaw).not.toHaveBeenCalled();
    expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('bricht eine hängende Registration-Verifikation nach 30 Sekunden bis in die Dependency ab', async () => {
    vi.useFakeTimers();
    try {
      // T-02: Die CRL-Abrufe laufen in der eigenen Kettenprüfung; deren Signal bricht ab.
      mocks.assertTrustedAttestationPath.mockImplementationOnce(
        () => new Promise<undefined>(() => undefined),
      );
      const attempt = verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      });
      const rejected = expect(attempt).rejects.toThrow(/konnte nicht verifiziert/i);
      await vi.waitFor(() => expect(mocks.assertTrustedAttestationPath).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      const options = mocks.assertTrustedAttestationPath.mock.calls[0]?.[0] as {
        signal?: AbortSignal;
      };
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('begrenzt auch eine hängende Bibliotheksprüfung auf 30 Sekunden', async () => {
    vi.useFakeTimers();
    try {
      mocks.verifyRegistrationResponse.mockImplementationOnce(() => new Promise(() => undefined));
      const attempt = verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      });
      const rejected = expect(attempt).rejects.toThrow(/konnte nicht verifiziert/i);
      await vi.waitFor(() => expect(mocks.verifyRegistrationResponse).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(mocks.assertTrustedAttestationPath).not.toHaveBeenCalled();
      expect(mocks.logWarn).toHaveBeenCalledWith(
        {
          component: 'staff-webauthn',
          err: 'Zeitlimit der Hardware-Attestationsprüfung überschritten',
        },
        'WebAuthn-Registrierung abgewiesen',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('prüft die x5c-Kette erst nach Bibliothek und Modellbindung gegen die gespeicherten Wurzeln', async () => {
    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).resolves.toEqual(expect.objectContaining({ metadataSerial: 7n }));

    expect(mocks.assertTrustedAttestationPath).toHaveBeenCalledOnce();
    expect(mocks.assertTrustedAttestationPath).toHaveBeenCalledWith({
      certificateChain: [new Uint8Array([1])],
      attestationRootCertificates: ['trusted-root'],
      signal: expect.any(AbortSignal),
    });
    expect(mocks.verifyRegistrationResponse.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertTrustedAttestationPath.mock.invocationCallOrder[0]!,
    );
    // SimpleWebAuthn führt ohne Wurzeln keinen Netzzugriff aus und erhält kein Signal.
    expect(mocks.verifyRegistrationResponse.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('weist eine nicht vertrauenswürdige oder gesperrte Attestationskette generisch ab', async () => {
    mocks.assertTrustedAttestationPath.mockRejectedValueOnce(
      new Error('x5c could not be chained to any specified trust anchor'),
    );

    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow('Der Sicherheitsschlüssel konnte nicht verifiziert werden.');
    expect(mocks.logWarn).toHaveBeenCalledWith(
      {
        component: 'staff-webauthn',
        err: 'x5c could not be chained to any specified trust anchor',
      },
      'WebAuthn-Registrierung abgewiesen',
    );
  });

  it('prüft genau die Kette, deren Blatt SimpleWebAuthn verifiziert hat', async () => {
    const preflight: unknown = mocks.decodeAttestationObject();
    mocks.decodeAttestationObject.mockReturnValueOnce(preflight).mockReturnValueOnce({
      get: (key: string) => (key === 'attStmt' ? { get: () => [new Uint8Array([2])] } : undefined),
    });

    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow('Der Sicherheitsschlüssel konnte nicht verifiziert werden.');
    expect(mocks.assertTrustedAttestationPath).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      {
        component: 'staff-webauthn',
        err: 'Die verifizierte Attestationskette weicht von der Vorprüfung ab',
      },
      'WebAuthn-Registrierung abgewiesen',
    );
  });

  it('schließt ein Modell aus, sobald SimpleWebAuthn selbst Attestationswurzeln erhielte', async () => {
    mocks.metadataGetStatement.mockResolvedValue(trustedMetadataStatement());

    await expect(beginHardwareLogin()).rejects.toThrow(
      /keines der freigegebenen Sicherheitsschlüssel-Modelle kann aktuell verifiziert werden/i,
    );
    expect(mocks.logWarn).toHaveBeenCalledWith(
      {
        component: 'staff-webauthn',
        aaguid: HARDWARE_AAGUID,
        err: `AAGUID ${HARDWARE_AAGUID}: SimpleWebAuthn darf keine Attestationswurzeln erhalten`,
      },
      'FIDO-Schlüsselmodell konnte nicht in den Attestationsspeicher übernommen werden',
    );
  });

  it.each([
    ['fehlende', undefined],
    ['fehlerhafte', new Uint8Array([0x02, 0x00])],
  ])('lehnt eine %s attestierte Firmware-Version ab', async (_case, encodedVersion) => {
    mocks.firmwareExtensionValue = encodedVersion;

    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/Firmware-Version/i);
  });

  it.each([40, 41])(
    'akzeptiert attestierte Firmware-Version %i ab der MDS-Mindestversion',
    async (version) => {
      mocks.firmwareExtensionValue = encodedFirmwareVersion(version);

      await expect(
        verifyHardwareRegistration({
          response: registrationResponse(),
          ceremony: ceremony('register'),
        }),
      ).resolves.toEqual(expect.objectContaining({ authenticatorVersion: BigInt(version) }));
    },
  );

  it('lehnt Firmware unter der Metadata-Statement- oder Status-Mindestversion ab', async () => {
    mocks.firmwareExtensionValue = encodedFirmwareVersion(39);
    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/nicht vertrauenswürdig/i);

    mocks.firmwareExtensionValue = encodedFirmwareVersion(42);
    setMetadataReports([
      {
        status: 'FIDO_CERTIFIED_L2',
        effectiveDate: '2020-01-01',
        authenticatorVersion: 43,
      },
    ]);
    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/nicht vertrauenswürdig/i);
  });

  it('lehnt self-attestation und nicht hardwaregeschützte MDS-Modelle fail-closed ab', async () => {
    mocks.decodeAttestationObject.mockReturnValueOnce({
      get: (key: string) =>
        key === 'fmt'
          ? 'packed'
          : key === 'attStmt'
            ? { get: () => undefined }
            : new Uint8Array([1]),
    });
    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/vollständige.*Hardware-Attestation/i);

    mocks.metadataGetStatement.mockResolvedValueOnce({
      ...trustedMetadataStatement(),
      attestationRootCertificates: [],
      keyProtection: ['software'],
    });
    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).rejects.toThrow(/keines der freigegebenen Sicherheitsschlüssel-Modelle/i);
  });

  it('bindet discoverable Login-Credentials an den erwarteten User-Handle und UV', async () => {
    const credential = {
      id: 'credential-id-long-enough',
      aaguid: HARDWARE_AAGUID,
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 6n,
      webauthnUserId: USER_HANDLE,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationFormat: 'packed',
      attestationVerifiedAt: new Date(),
      authenticatorVersion: 42n,
    };

    await expect(
      verifyHardwareAssertion({
        response: authenticationResponse(),
        ceremony: ceremony(),
        credential,
        staffId: STAFF_ID,
        requireUserHandle: true,
      }),
    ).resolves.toEqual({ newSignCount: 7n, metadataSerial: 7n });
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'challenge-value',
        expectedOrigin: 'https://kanzlei.example.test',
        expectedRPID: 'kanzlei.example.test',
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: 'required' },
      }),
    );

    mocks.verifyAuthenticationResponse.mockClear();
    await expect(
      verifyHardwareAssertion({
        response: authenticationResponse('wrong-user-handle'),
        ceremony: ceremony(),
        credential,
        staffId: STAFF_ID,
        requireUserHandle: true,
      }),
    ).rejects.toThrow(/gehört nicht zu diesem Konto/i);
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('entzieht bestehendem Credential den Login, sobald seine AAGUID nicht mehr freigegeben ist', async () => {
    const credential = {
      id: 'credential-id-long-enough',
      aaguid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 6n,
      webauthnUserId: USER_HANDLE,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationFormat: 'packed',
      attestationVerifiedAt: new Date(),
      authenticatorVersion: 42n,
    };

    await expect(
      verifyHardwareAssertion({
        response: authenticationResponse(),
        ceremony: ceremony(),
        credential,
        staffId: STAFF_ID,
        requireUserHandle: true,
      }),
    ).rejects.toThrow(/Modell ist nicht freigegeben/i);
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it.each(['REVOKED', 'NOT_FIDO_CERTIFIED', 'SELF_ASSERTION_SUBMITTED', 'UNKNOWN_VENDOR_STATUS'])(
    'lehnt den MDS-Status %s vor der kryptografischen Assertion fail-closed ab',
    async (status) => {
      setMetadataStatus([status]);
      const credential = {
        id: 'credential-id-long-enough',
        aaguid: HARDWARE_AAGUID,
        publicKey: new Uint8Array([1, 2, 3]),
        signCount: 6n,
        webauthnUserId: USER_HANDLE,
        transports: ['usb'],
        deviceType: 'singleDevice',
        backedUp: false,
        attestationFormat: 'packed',
        attestationVerifiedAt: new Date(),
        authenticatorVersion: 42n,
      };

      await expect(
        verifyHardwareAssertion({
          response: authenticationResponse(),
          ceremony: ceremony(),
          credential,
          staffId: STAFF_ID,
          requireUserHandle: true,
        }),
      ).rejects.toThrow(/keines der freigegebenen Sicherheitsschlüssel-Modelle/i);
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
    },
  );

  it('akzeptiert einen zertifizierten Status mit verfügbarem Firmware-Update', async () => {
    setMetadataStatus(['FIDO_CERTIFIED_L2', 'UPDATE_AVAILABLE']);
    const credential = {
      id: 'credential-id-long-enough',
      aaguid: HARDWARE_AAGUID,
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 6n,
      webauthnUserId: USER_HANDLE,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationFormat: 'packed',
      attestationVerifiedAt: new Date(),
      authenticatorVersion: 42n,
    };

    await expect(
      verifyHardwareAssertion({
        response: authenticationResponse(),
        ceremony: ceremony(),
        credential,
        staffId: STAFF_ID,
        requireUserHandle: true,
      }),
    ).resolves.toEqual({ newSignCount: 7n, metadataSerial: 7n });
  });

  it('verlangt neben UPDATE_AVAILABLE einen aktuell wirksamen Zertifizierungsstatus', async () => {
    setMetadataStatus(['UPDATE_AVAILABLE']);
    const credential = {
      id: 'credential-id-long-enough',
      aaguid: HARDWARE_AAGUID,
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 6n,
      webauthnUserId: USER_HANDLE,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationFormat: 'packed',
      attestationVerifiedAt: new Date(),
      authenticatorVersion: 42n,
    };

    await expect(
      verifyHardwareAssertion({
        response: authenticationResponse(),
        ceremony: ceremony(),
        credential,
        staffId: STAFF_ID,
      }),
    ).rejects.toThrow(/keines der freigegebenen Sicherheitsschlüssel-Modelle/i);
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it.each([
    ['abgelaufenes', '2020-01-01'],
    ['heutiges', new Date().toISOString().slice(0, 10)],
    ['ungültiges', '2026-02-30'],
  ])(
    'akzeptiert kein %s sunsetDate als aktuellen Zertifizierungsnachweis',
    async (_case, sunsetDate) => {
      setMetadataReports([
        { status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-01-01', sunsetDate },
      ]);

      await expect(
        verifyHardwareAssertion({
          response: authenticationResponse(),
          ceremony: ceremony(),
          credential: {
            id: 'credential-id-long-enough',
            aaguid: HARDWARE_AAGUID,
            publicKey: new Uint8Array([1, 2, 3]),
            signCount: 6n,
            webauthnUserId: USER_HANDLE,
            transports: ['usb'],
            deviceType: 'singleDevice',
            backedUp: false,
            attestationFormat: 'packed',
            attestationVerifiedAt: new Date(),
            authenticatorVersion: 42n,
          },
          staffId: STAFF_ID,
        }),
      ).rejects.toThrow(/keines der freigegebenen Sicherheitsschlüssel-Modelle/i);
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '2099-01-01'])(
    'akzeptiert einen Zertifizierungsnachweis mit zukünftigem/fehlendem sunsetDate (%s)',
    async (sunsetDate) => {
      setMetadataReports([
        { status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-01-01', sunsetDate },
      ]);

      await expect(
        verifyHardwareAssertion({
          response: authenticationResponse(),
          ceremony: ceremony(),
          credential: {
            id: 'credential-id-long-enough',
            aaguid: HARDWARE_AAGUID,
            publicKey: new Uint8Array([1, 2, 3]),
            signCount: 6n,
            webauthnUserId: USER_HANDLE,
            transports: ['usb'],
            deviceType: 'singleDevice',
            backedUp: false,
            attestationFormat: 'packed',
            attestationVerifiedAt: new Date(),
            authenticatorVersion: 42n,
          },
          staffId: STAFF_ID,
        }),
      ).resolves.toEqual({ newSignCount: 7n, metadataSerial: 7n });
    },
  );

  it('sperrt fail-closed, sobald die letzte MDS-Prüfung älter als eine Stunde ist', async () => {
    await beginHardwareRegistration({
      staffId: STAFF_ID,
      tenantId: '11111111-1111-4111-8111-111111111111',
      authRevision: 4,
      email: 'staff@example.test',
      fullName: 'Staff Test',
      existingCredentials: [],
    });
    vi.useFakeTimers({ now: new Date(mocks.trust.verifiedAt.getTime() + 60 * 60 * 1000 + 1) });
    try {
      await expect(
        verifyHardwareAssertion({
          response: authenticationResponse(),
          ceremony: ceremony(),
          credential: {
            id: 'credential-id-long-enough',
            aaguid: HARDWARE_AAGUID,
            publicKey: new Uint8Array([1, 2, 3]),
            signCount: 6n,
            webauthnUserId: USER_HANDLE,
            transports: ['usb'],
            deviceType: 'singleDevice',
            backedUp: false,
            attestationFormat: 'packed',
            attestationVerifiedAt: new Date(),
            authenticatorVersion: 42n,
          },
          staffId: STAFF_ID,
        }),
      ).rejects.toThrow(/derzeit nicht geprüft/i);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
      expect(mocks.logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'staff-webauthn', serial: '7' }),
        'FIDO-Metadaten sind veraltet (Worker-Job fido-mds-refresh prüfen)',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('übernimmt einen neueren gespeicherten Stand ohne eigenen MDS-Abruf', async () => {
    await beginHardwareRegistration({
      staffId: STAFF_ID,
      tenantId: '11111111-1111-4111-8111-111111111111',
      authRevision: 4,
      email: 'staff@example.test',
      fullName: 'Staff Test',
      existingCredentials: [],
    });
    expect(snapshotReads()).toBe(1);
    // Der Worker hat zwischenzeitlich BLOB-Serie 8 verankert und gespeichert.
    mocks.snapshots.set(8n, { sha256: 'e'.repeat(64), entries: [metadataEntry] });
    mocks.trust.blobSerial = 8n;

    await expect(
      verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      }),
    ).resolves.toEqual(expect.objectContaining({ metadataSerial: 8n }));
    expect(snapshotReads()).toBe(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('liest die Snapshot-Einträge je gespeichertem Stand nur einmal', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await beginHardwareLogin();
    }
    expect(snapshotReads()).toBe(1);
    expect(mocks.metadataInitialize).toHaveBeenCalledOnce();
  });

  it.each([
    ['ohne bisher geprüften BLOB (Serie 0)', () => (mocks.trust.blobSerial = 0n)],
    ['ohne gespeicherten Snapshot', () => mocks.snapshots.clear()],
  ])('sperrt Hardware-Vorgänge explizit %s', async (_case, arrange) => {
    arrange();

    await expect(beginHardwareLogin()).rejects.toThrow(/derzeit nicht geprüft/i);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      { component: 'staff-webauthn' },
      'FIDO-Metadaten liegen noch nicht vor (Worker-Job fido-mds-refresh)',
    );
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('sperrt fail-closed, wenn der Snapshot zwischen Anker- und Inhaltsabfrage ersetzt wurde', async () => {
    mocks.prismaQueryRaw.mockImplementation((strings: TemplateStringsArray, ...values) =>
      isSnapshotEntriesQuery(strings.join(' '))
        ? Promise.resolve([{ blob_sha256: 'd'.repeat(64), entry: metadataEntry }])
        : storedTrustStateQuery(strings, ...values),
    );

    await expect(beginHardwareLogin()).rejects.toThrow(/derzeit nicht geprüft/i);
    expect(mocks.metadataInitialize).not.toHaveBeenCalled();
  });

  it('fragt aus dem gespeicherten Stand nur die Einträge der freigegebenen AAGUIDs ab', async () => {
    const otherEntry = {
      ...metadataEntry,
      aaguid: REJECTED_HARDWARE_AAGUID,
      metadataStatement: { ...trustedMetadataStatement(), aaguid: REJECTED_HARDWARE_AAGUID },
    };
    mocks.snapshots.set(7n, { sha256: SNAPSHOT_SHA256, entries: [otherEntry, metadataEntry] });

    await expect(beginHardwareLogin()).resolves.toBeDefined();
    const snapshotQuery = mocks.prismaQueryRaw.mock.calls.find(([strings]) =>
      isSnapshotEntriesQuery((strings as TemplateStringsArray).join(' ')),
    );
    expect(snapshotQuery?.slice(1)).toEqual([[HARDWARE_AAGUID], 7n]);
    expect(mocks.metadataInitialize).toHaveBeenCalledWith({
      mdsServers: [],
      statements: [{ ...metadataEntry.metadataStatement, attestationRootCertificates: [] }],
      verificationMode: 'strict',
    });
  });

  it('verwirft einen gespeicherten Stand, dessen nextUpdate erreicht ist', async () => {
    mocks.trust.nextUpdate = '2020-01-01';
    const credential = {
      id: 'credential-id-long-enough',
      aaguid: HARDWARE_AAGUID,
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 6n,
      webauthnUserId: USER_HANDLE,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationFormat: 'packed',
      attestationVerifiedAt: new Date(),
      authenticatorVersion: 42n,
    };

    await expect(
      verifyHardwareAssertion({
        response: authenticationResponse(),
        ceremony: ceremony(),
        credential,
        staffId: STAFF_ID,
      }),
    ).rejects.toThrow(/derzeit nicht geprüft/i);
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('sperrt bei abweichender persistenter Hardware-Policy, statt einen fremden Stand zu nutzen', async () => {
    mocks.prismaQueryRaw.mockImplementation((strings: TemplateStringsArray, ...values) =>
      isTrustStateQuery(strings.join(' '))
        ? storedTrustStateQuery(strings, ...values).then((rows) =>
            (rows as Array<Record<string, unknown>>).map((row) => ({
              ...row,
              policy_hash: 'c'.repeat(64),
            })),
          )
        : storedTrustStateQuery(strings, ...values),
    );

    await expect(beginHardwareLogin()).rejects.toThrow(/derzeit nicht geprüft/i);
    expect(snapshotReads()).toBe(0);
  });

  it('ACCESS-TENANT-RLS-001: ein neuerer Stand ohne nutzbares Modell verdrängt den Prozess-Cache', async () => {
    await beginHardwareLogin();
    const rejectedEntry = {
      ...metadataEntry,
      statusReports: [{ status: 'REVOKED', effectiveDate: '2020-01-01' }],
    };
    mocks.snapshots.set(8n, { sha256: 'e'.repeat(64), entries: [rejectedEntry] });
    mocks.trust.blobSerial = 8n;
    mocks.generateAuthenticationOptions.mockClear();

    await expect(beginHardwareLogin()).rejects.toThrow(
      /keines der freigegebenen Sicherheitsschlüssel-Modelle/i,
    );
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'staff-webauthn', aaguid: HARDWARE_AAGUID }),
      'FIDO-Schlüsselmodell aus aktuellem Vertrauenssnapshot ausgeschlossen',
    );
  });

  it('isoliert ein gesperrtes Modell, ohne gültige Modelle oder den Snapshot-Cache zu blockieren', async () => {
    mocks.hardwareAaguids.push(REJECTED_HARDWARE_AAGUID);
    const rejectedEntry = {
      ...metadataEntry,
      aaguid: REJECTED_HARDWARE_AAGUID,
      metadataStatement: {
        ...trustedMetadataStatement(),
        aaguid: REJECTED_HARDWARE_AAGUID,
      },
      statusReports: [{ status: 'REVOKED', effectiveDate: '2020-01-01' }],
    };
    mocks.snapshots.set(8n, { sha256: 'e'.repeat(64), entries: [metadataEntry, rejectedEntry] });
    mocks.trust.blobSerial = 8n;

    await expect(
      beginHardwareRegistration({
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
        email: 'staff@example.test',
        fullName: 'Staff Test',
        existingCredentials: [],
      }),
    ).resolves.toBeDefined();
    expect(mocks.metadataInitialize).toHaveBeenCalledWith({
      mdsServers: [],
      statements: [{ ...metadataEntry.metadataStatement, attestationRootCertificates: [] }],
      verificationMode: 'strict',
    });

    await expect(
      verifyHardwareAssertion({
        response: authenticationResponse(),
        ceremony: ceremony(),
        credential: {
          id: 'rejected-credential-id',
          aaguid: REJECTED_HARDWARE_AAGUID,
          publicKey: new Uint8Array([1, 2, 3]),
          signCount: 6n,
          webauthnUserId: USER_HANDLE,
          transports: ['usb'],
          deviceType: 'singleDevice',
          backedUp: false,
          attestationFormat: 'packed',
          attestationVerifiedAt: new Date(),
          authenticatorVersion: 42n,
        },
        staffId: STAFF_ID,
      }),
    ).rejects.toThrow(/nicht vertrauenswürdig/i);
    expect(snapshotReads()).toBe(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('tenantgebundener Audit-Trail fuer Hardware-Login-Fehler', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';

  function storedCredential(overrides: Record<string, unknown> = {}) {
    return {
      id: '33333333-3333-4333-8333-333333333333',
      tenantId,
      staffUserId: STAFF_ID,
      credentialId: 'credential-id-long-enough',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 6n,
      webauthnUserId: USER_HANDLE,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      revokedAt: null,
      aaguid: HARDWARE_AAGUID,
      authenticatorVersion: 42n,
      attestationVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      attestationFormat: 'packed',
      staffUser: {
        id: STAFF_ID,
        email: 'secret-staff@example.test',
        fullName: 'Hardware Staff',
        active: true,
        lockedUntil: null,
        hardwareOnlyEnabledAt: new Date('2026-09-01T00:00:00.000Z'),
        authRevision: 4,
        roles: [{ role: 'ADMIN' }],
        permissions: [],
      },
      ...overrides,
    };
  }

  it('bindet einen erfolgreichen Hardware-Login im Commit an dessen MDS-Serie', async () => {
    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony()));
    mocks.credentialFindUnique.mockResolvedValueOnce(storedCredential());
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ matches: true }]),
      staffWebAuthnCredential: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      staffUser: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mocks.prismaTransaction.mockImplementationOnce(
      async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    );

    await expect(
      authenticateStaffHardwareCredential({
        ceremonyId: CEREMONY_ID,
        responseJson: JSON.stringify(authenticationResponse()),
        ip: '203.0.113.8',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        staffId: STAFF_ID,
        tenantId,
        authMethod: 'security_key',
        authRevision: 4,
      }),
    );
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.staffWebAuthnCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { signCount: 7n, lastUsedAt: expect.any(Date) } }),
    );
  });

  it('erzeugt fuer unbekannte Credential-IDs kein tenantloses Ereignis', async () => {
    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony()));
    mocks.credentialFindUnique.mockResolvedValueOnce(null);

    await expect(
      authenticateStaffHardwareCredential({
        ceremonyId: CEREMONY_ID,
        responseJson: JSON.stringify(authenticationResponse()),
        ip: '203.0.113.8',
      }),
    ).resolves.toBeNull();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.prismaTransaction).not.toHaveBeenCalled();
  });

  it('auditiert einen bekannten, nicht nutzbaren Schluessel ohne Credential- oder Kontodaten', async () => {
    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony()));
    mocks.credentialFindUnique.mockResolvedValueOnce(
      storedCredential({ revokedAt: new Date('2026-09-02T00:00:00.000Z') }),
    );

    await expect(
      authenticateStaffHardwareCredential({
        ceremonyId: CEREMONY_ID,
        responseJson: JSON.stringify(authenticationResponse()),
        ip: '203.0.113.8',
      }),
    ).resolves.toBeNull();
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      {},
      {
        tenantId,
        actorType: 'STAFF',
        actorId: STAFF_ID,
        action: 'auth.login.failure',
        resourceType: 'staff_user',
        resourceId: STAFF_ID,
        after: { method: 'security_key', reason: 'security_key' },
        ip: '203.0.113.8',
      },
    );
    const serializedAudit = JSON.stringify(mocks.evidenceRecord.mock.calls[0]?.[1]);
    expect(serializedAudit).not.toContain('credential-id-long-enough');
    expect(serializedAudit).not.toContain('secret-staff@example.test');
    expect(serializedAudit).not.toContain(HARDWARE_AAGUID);
  });

  it('auditiert auch eine fehlgeschlagene kryptografische Pruefung generisch', async () => {
    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony()));
    mocks.credentialFindUnique.mockResolvedValueOnce(storedCredential());
    mocks.verifyAuthenticationResponse.mockRejectedValueOnce(new Error('private verifier detail'));

    await expect(
      authenticateStaffHardwareCredential({
        ceremonyId: CEREMONY_ID,
        responseJson: JSON.stringify(authenticationResponse()),
        ip: null,
      }),
    ).rejects.toBeInstanceOf(HardwareAccessVerificationError);
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceRecord.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tenantId,
        action: 'auth.login.failure',
        after: { method: 'security_key', reason: 'security_key' },
        ip: null,
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls[0]?.[1])).not.toContain(
      'private verifier detail',
    );
  });

  it('haelt auch bei einem Audit-Ausfall die externe Ablehnung generisch', async () => {
    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony()));
    mocks.credentialFindUnique.mockResolvedValueOnce(
      storedCredential({ revokedAt: new Date('2026-09-02T00:00:00.000Z') }),
    );
    mocks.evidenceRecord.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      authenticateStaffHardwareCredential({
        ceremonyId: CEREMONY_ID,
        responseJson: JSON.stringify(authenticationResponse()),
        ip: '203.0.113.8',
      }),
    ).resolves.toBeNull();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      { component: 'staff-webauthn' },
      'Abgewiesene Hardware-Anmeldung konnte nicht auditiert werden',
    );
  });

  function loginCommitTransaction(overrides: {
    matches?: boolean;
    keyUpdates?: number;
    userUpdates?: number;
  }) {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ matches: overrides.matches ?? true }]),
      staffWebAuthnCredential: {
        updateMany: vi.fn().mockResolvedValue({ count: overrides.keyUpdates ?? 1 }),
      },
      staffUser: { updateMany: vi.fn().mockResolvedValue({ count: overrides.userUpdates ?? 1 }) },
    };
    mocks.prismaTransaction.mockImplementationOnce(
      async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    );
    return tx;
  }

  async function attemptLogin() {
    mocks.redisEval.mockResolvedValueOnce(JSON.stringify(ceremony()));
    mocks.credentialFindUnique.mockResolvedValueOnce(storedCredential());
    return authenticateStaffHardwareCredential({
      ceremonyId: CEREMONY_ID,
      responseJson: JSON.stringify(authenticationResponse()),
      ip: '203.0.113.8',
    });
  }

  it('weist den Commit ab und auditiert, wenn sich der MDS-Stand seit der Prüfung geändert hat', async () => {
    const tx = loginCommitTransaction({ matches: false });

    await expect(attemptLogin()).rejects.toThrow(/zwischenzeitlich aktualisiert/);
    expect(tx.staffWebAuthnCredential.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: 'auth.login.failure', tenantId }),
    );
  });

  it('meldet einen parallel verbrauchten Signaturzähler ohne Kontoänderung als Fehlschlag', async () => {
    const tx = loginCommitTransaction({ keyUpdates: 0 });

    await expect(attemptLogin()).resolves.toBeNull();
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceRecord.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ action: 'auth.login.failure' }),
    );
  });

  it('rollt den Zähler zurück, wenn sich Konto oder Auth-Revision parallel geändert haben', async () => {
    loginCommitTransaction({ userUpdates: 0 });

    await expect(attemptLogin()).rejects.toBeInstanceOf(HardwareAccessVerificationError);
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceRecord.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ action: 'auth.login.failure' }),
    );
  });
});

// P-23: Die Aufteilung von webauthn.ts ist nur mit vollständiger Testabdeckung
// des verschobenen Codes zulässig. Diese Fälle decken die Fehler- und
// Randzweige ab, die zuvor ungetestet waren.
describe('P-23: Rand- und Fehlerzweige der aufgeteilten WebAuthn-Module', () => {
  const credential = {
    id: 'credential-id-long-enough',
    aaguid: HARDWARE_AAGUID,
    publicKey: new Uint8Array([1, 2, 3]),
    signCount: 6n,
    webauthnUserId: USER_HANDLE,
    transports: ['usb'],
    deviceType: 'singleDevice',
    backedUp: false,
    attestationFormat: 'packed',
    attestationVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    authenticatorVersion: 42n,
  };

  async function withEnv(overrides: Partial<typeof mutableEnv>, run: () => Promise<void> | void) {
    const previous = { ...mutableEnv };
    Object.assign(mutableEnv, overrides);
    try {
      await run();
    } finally {
      mutableEnv.NODE_ENV = previous.NODE_ENV;
      mutableEnv.NEXTAUTH_URL = previous.NEXTAUTH_URL;
    }
  }

  describe('Metadaten und Policy', () => {
    it('erlaubt den Cache-Reset ausschließlich in Tests', async () => {
      await withEnv({ NODE_ENV: 'production' }, () => {
        expect(() => resetHardwareMetadataCacheForTests()).toThrow(/ausschließlich in Tests/);
      });
    });

    it.each([[[]], [['00000000-0000-0000-0000-000000000000']]])(
      'weist gespeicherte Credentials ohne konfigurierte Vertrauensliste ab (%j)',
      async (allowlist) => {
        mocks.hardwareAaguids.splice(0, Infinity, ...allowlist);
        await expect(assertStoredHardwareCredentialTrusted(credential)).rejects.toThrow(
          'Die Hardware-Vertrauensliste ist nicht konfiguriert.',
        );
      },
    );

    it('verweigert den Commit-Guard bei zentral deaktiviertem Hardware-Zugang', async () => {
      mocks.hardwareAaguids.splice(0, Infinity);
      const tx = { $queryRaw: vi.fn() };
      await expect(lockMatchingHardwareMetadataSerial(tx as never, 7n)).rejects.toThrow(
        'Der Hardware-Zugang ist zentral deaktiviert.',
      );
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('sperrt fail-closed, wenn der gespeicherte Vertrauensanker nicht lesbar ist', async () => {
      mocks.prismaQueryRaw.mockImplementation((strings: TemplateStringsArray, ...values) =>
        isTrustStateQuery(strings.join(' '))
          ? Promise.reject(new Error('Datenbank nicht erreichbar'))
          : storedTrustStateQuery(strings, ...values),
      );

      const attempt = beginHardwareLogin();
      await expect(attempt).rejects.toBeInstanceOf(HardwareAccessUnavailableError);
      await expect(attempt).rejects.toThrow(/derzeit nicht geprüft/);
      expect(mocks.logWarn).toHaveBeenCalledWith(
        { component: 'staff-webauthn', err: 'Datenbank nicht erreichbar' },
        'FIDO-Metadaten-Richtlinie ist nicht bereit',
      );
      expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    });

    it.each([
      [
        'ungültiger Firmware-Mindestwert im Statement',
        () => {
          (
            metadataEntry.metadataStatement as { authenticatorVersion: number }
          ).authenticatorVersion = -1;
        },
        /Firmware-Mindestversion im Metadata Statement/,
      ],
      [
        'ungültiger Firmware-Mindestwert im Statusbericht',
        () =>
          setMetadataReports([
            { status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-01-01', authenticatorVersion: 1.5 },
          ]),
        /Firmware-Mindestversion im MDS-Statusbericht/,
      ],
      [
        'nicht existierendes effectiveDate',
        () => setMetadataReports([{ status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-02-30' }]),
        /kein gültiges MDS-effectiveDate/,
      ],
      [
        'effectiveDate ohne Kalenderformat',
        () => setMetadataReports([{ status: 'FIDO_CERTIFIED_L2', effectiveDate: '20200101' }]),
        /kein gültiges MDS-effectiveDate/,
      ],
      [
        'nicht existierendes sunsetDate',
        () =>
          setMetadataReports([
            { status: 'FIDO_CERTIFIED_L2', effectiveDate: '2020-01-01', sunsetDate: '2099-13-01' },
          ]),
        /kein gültiges MDS-sunsetDate/,
      ],
      [
        'Eintrag ohne Statusberichte',
        () => {
          Object.assign(metadataEntry, { statusReports: undefined });
        },
        /keinen belastbaren MDS-Status/,
      ],
    ])('schließt ein Modell bei %s aus dem Snapshot aus', async (_case, arrange, warning) => {
      arrange();

      await expect(beginHardwareLogin()).rejects.toThrow(
        /keines der freigegebenen Sicherheitsschlüssel-Modelle/i,
      );
      expect(mocks.logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ aaguid: HARDWARE_AAGUID, err: expect.stringMatching(warning) }),
        'FIDO-Schlüsselmodell aus aktuellem Vertrauenssnapshot ausgeschlossen',
      );
    });
  });

  describe('Relying Party und Zeremonien', () => {
    it('meldet die Hardware-Anmeldung nur mit Allowlist und HTTPS-Adresse als konfiguriert', async () => {
      expect(isHardwareAccessConfigured()).toBe(true);
      await withEnv({ NEXTAUTH_URL: 'http://localhost:3000' }, () => {
        expect(isHardwareAccessConfigured()).toBe(true);
      });
      await withEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'http://localhost:3000' }, () => {
        expect(isHardwareAccessConfigured()).toBe(false);
      });
      await withEnv({ NEXTAUTH_URL: 'http://kanzlei.example.test' }, () => {
        expect(isHardwareAccessConfigured()).toBe(false);
      });
      mocks.hardwareAaguids.splice(0, Infinity);
      expect(isHardwareAccessConfigured()).toBe(false);
    });

    it('startet ohne HTTPS-Adresse keine Zeremonie', async () => {
      await withEnv({ NEXTAUTH_URL: 'http://kanzlei.example.test' }, async () => {
        await expect(beginHardwareLogin()).rejects.toThrow(
          'Sicherheitsschlüssel benötigen eine konfigurierte HTTPS-Adresse.',
        );
      });
      expect(mocks.redisSet).not.toHaveBeenCalled();
    });

    it.each([
      ['Redis-Fehler', () => mocks.redisSet.mockRejectedValueOnce(new Error('redis down'))],
      ['ID-Kollision', () => mocks.redisSet.mockResolvedValueOnce(null)],
    ])('meldet eine nicht speicherbare Zeremonie generisch (%s)', async (_case, arrange) => {
      arrange();
      await expect(beginHardwareLogin()).rejects.toBeInstanceOf(HardwareAccessUnavailableError);
      expect(mocks.logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'staff-webauthn' }),
        'WebAuthn-Zeremonie konnte nicht gespeichert werden',
      );
    });

    it('übernimmt nur gültige Transporte bereits registrierter Schlüssel in excludeCredentials', async () => {
      await beginHardwareRegistration({
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
        email: 'staff@example.test',
        fullName: 'Staff Test',
        existingCredentials: [
          { credentialId: 'existing-credential', transports: ['usb', 'bogus', 'usb', 'nfc'] },
        ],
      });
      expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          excludeCredentials: [{ id: 'existing-credential', transports: ['usb', 'nfc'] }],
        }),
      );
    });

    it('prüft das Format der Zeremonie-ID vor jedem Redis-Zugriff', async () => {
      await expect(
        consumeHardwareCeremony({ ceremonyId: 'zu-kurz', purpose: 'login' }),
      ).rejects.toThrow('Die Schlüssel-Anfrage ist ungültig oder abgelaufen.');
      expect(mocks.redisEval).not.toHaveBeenCalled();
    });

    it('meldet einen Redis-Fehler beim Verbrauch der Zeremonie als nicht verfügbar', async () => {
      mocks.redisEval.mockRejectedValueOnce(new Error('redis down'));
      await expect(
        consumeHardwareCeremony({ ceremonyId: CEREMONY_ID, purpose: 'login' }),
      ).rejects.toBeInstanceOf(HardwareAccessUnavailableError);
      expect(mocks.logWarn).toHaveBeenCalledWith(
        { component: 'staff-webauthn', err: 'redis down' },
        'WebAuthn-Zeremonie konnte nicht verbraucht werden',
      );
    });

    it.each(['{kein json', 'null', '"text"'])(
      'weist einen unlesbaren gespeicherten Zeremoniewert ab (%s)',
      async (stored) => {
        mocks.redisEval.mockResolvedValueOnce(stored);
        await expect(
          consumeHardwareCeremony({ ceremonyId: CEREMONY_ID, purpose: 'login' }),
        ).rejects.toThrow('Die Schlüssel-Anfrage ist ungültig oder abgelaufen.');
      },
    );

    it.each(['', '{kein json', 'null', '42', 'x'.repeat(128 * 1024 + 1)])(
      'weist eine unlesbare Assertion-Antwort ab (%#)',
      (raw) => {
        expect(() => parseAuthenticationResponse(raw)).toThrow(HardwareAccessVerificationError);
      },
    );

    it('erkennt Registrierungs- und Assertion-Antworten nur in vollständiger Form', () => {
      expect(isRegistrationResponse(registrationResponse())).toBe(true);
      expect(isRegistrationResponse(null)).toBe(false);
      expect(isRegistrationResponse({ ...registrationResponse(), type: 'other' })).toBe(false);
      expect(isAuthenticationResponse(authenticationResponse())).toBe(true);
      expect(isAuthenticationResponse(null)).toBe(false);
      expect(isAuthenticationResponse({ ...authenticationResponse(), id: 'kurz' })).toBe(false);
    });
  });

  describe('Registrierung', () => {
    const registerCeremony = () => ceremony('register');

    it('weist eine nicht serialisierbare Registrierungsantwort ab', async () => {
      const response = {
        ...registrationResponse(),
        clientExtensionResults: { unexpected: 1n },
      } as unknown as RegistrationResponseJSON;
      await expect(
        verifyHardwareRegistration({ response, ceremony: registerCeremony() }),
      ).rejects.toThrow('Die Hardware-Attestation ist nicht lesbar.');
    });

    it('weist ein nicht dekodierbares Attestation-Objekt ab', async () => {
      mocks.decodeAttestationObject.mockImplementationOnce(() => {
        throw new Error('CBOR defekt');
      });
      await expect(
        verifyHardwareRegistration({
          response: registrationResponse(),
          ceremony: registerCeremony(),
        }),
      ).rejects.toThrow('Die Hardware-Attestation ist nicht lesbar.');
      expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
    });

    it.each([
      ['kein Byte-Array', 'zertifikat'],
      ['leeres Zertifikat', new Uint8Array(0)],
      ['zu großes Zertifikat', new Uint8Array(64 * 1024 + 1)],
    ])(
      'weist eine ungültige x5c-Kette vor jedem Netzzugriff ab (%s)',
      async (_case, certificate) => {
        mocks.decodeAttestationObject.mockReturnValueOnce({
          get: (key: string) =>
            key === 'fmt'
              ? 'packed'
              : key === 'attStmt'
                ? {
                    get: (statementKey: string) =>
                      statementKey === 'x5c' ? [certificate] : undefined,
                  }
                : undefined,
        });
        await expect(
          verifyHardwareRegistration({
            response: registrationResponse(),
            ceremony: registerCeremony(),
          }),
        ).rejects.toThrow('Die Attestationszertifikatskette ist ungültig.');
        expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['nicht verifiziert', { verified: false }],
      ['ohne User Verification', { userVerified: false }],
    ])('weist eine Registrierung %s ab', async (_case, override) => {
      const registered = (await mocks.verifyRegistrationResponse()) as {
        verified: boolean;
        registrationInfo: Record<string, unknown>;
      };
      mocks.verifyRegistrationResponse.mockClear();
      mocks.verifyRegistrationResponse.mockResolvedValueOnce(
        'verified' in override
          ? { ...registered, ...override }
          : { ...registered, registrationInfo: { ...registered.registrationInfo, ...override } },
      );
      await expect(
        verifyHardwareRegistration({
          response: registrationResponse(),
          ceremony: registerCeremony(),
        }),
      ).rejects.toBeInstanceOf(HardwareAccessVerificationError);
    });

    it('verlangt auch im Prüfergebnis das Format packed', async () => {
      const registered = (await mocks.verifyRegistrationResponse()) as {
        registrationInfo: Record<string, unknown>;
      };
      mocks.verifyRegistrationResponse.mockResolvedValueOnce({
        ...registered,
        registrationInfo: { ...registered.registrationInfo, fmt: 'none' },
      });
      await expect(
        verifyHardwareRegistration({
          response: registrationResponse(),
          ceremony: registerCeremony(),
        }),
      ).rejects.toThrow(
        'Der Schlüssel liefert keine vollständige freigegebene Hardware-Attestation.',
      );
    });

    it('weist eine falsch kodierte Zertifikat-AAGUID ab', async () => {
      mocks.aaguidExtensionValue = new Uint8Array(16).fill(0xaa);
      await expect(
        verifyHardwareRegistration({
          response: registrationResponse(),
          ceremony: registerCeremony(),
        }),
      ).rejects.toThrow('Die attestierte AAGUID des Sicherheitsschlüssels ist ungültig.');
    });

    it('meldet ein nicht auswertbares Attestationszertifikat generisch', async () => {
      mocks.certificateError = new Error('ASN.1-Strukturfehler');
      await expect(
        verifyHardwareRegistration({
          response: registrationResponse(),
          ceremony: registerCeremony(),
        }),
      ).rejects.toThrow('Der Sicherheitsschlüssel konnte nicht verifiziert werden.');
      expect(mocks.logWarn).toHaveBeenCalledWith(
        { component: 'staff-webauthn', aaguid: HARDWARE_AAGUID, err: 'ASN.1-Strukturfehler' },
        'Hardware-Attestation konnte nicht ausgewertet werden',
      );
    });

    it('bricht ab, wenn der Worker während der Attestationsprüfung einen neuen Stand verankert', async () => {
      const registered = await mocks.verifyRegistrationResponse();
      mocks.verifyRegistrationResponse.mockClear();
      mocks.verifyRegistrationResponse.mockImplementationOnce(async () => {
        mocks.snapshots.set(8n, { sha256: 'e'.repeat(64), entries: [metadataEntry] });
        mocks.trust.blobSerial = 8n;
        return registered;
      });
      const attempt = verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: registerCeremony(),
      });
      await expect(attempt).rejects.toBeInstanceOf(HardwareAccessUnavailableError);
      await expect(attempt).rejects.toThrow(/während der Attestationsprüfung aktualisiert/);
    });
  });

  describe('Assertion und gespeicherte Credentials', () => {
    it.each([
      ['ohne AAGUID', { aaguid: null }],
      ['ohne Firmware-Nachweis', { authenticatorVersion: null }],
      ['ohne packed-Attestation', { attestationFormat: 'none' }],
    ])('verlangt einen verifizierten Hardware-Nachweis (%s)', async (_case, override) => {
      await expect(
        assertStoredHardwareCredentialTrusted({ ...credential, ...override }),
      ).rejects.toThrow('Für diesen Schlüssel fehlt ein verifizierter Hardware-Nachweis.');
    });

    it.each([-1n, 2n ** 32n])(
      'verlangt eine gültige gespeicherte Firmware-Version (%s)',
      async (authenticatorVersion) => {
        await expect(
          assertStoredHardwareCredentialTrusted({ ...credential, authenticatorVersion }),
        ).rejects.toThrow('Für diesen Schlüssel fehlt eine gültige attestierte Firmware-Version.');
      },
    );

    it('weist einen ungültigen gespeicherten Signaturzähler vor der Kryptoprüfung ab', async () => {
      await expect(
        verifyHardwareAssertion({
          response: authenticationResponse(),
          ceremony: ceremony(),
          credential: { ...credential, signCount: -1n },
          staffId: STAFF_ID,
        }),
      ).rejects.toBeInstanceOf(HardwareAccessVerificationError);
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it.each([
      ['nicht verifiziert', { verified: false }],
      ['ohne User Verification', { userVerified: false }],
      ['als synchronisierbarer Passkey', { credentialDeviceType: 'multiDevice' }],
      ['mit Backup', { credentialBackedUp: true }],
    ])('weist eine Assertion %s ab', async (_case, override) => {
      const verified = (await mocks.verifyAuthenticationResponse()) as {
        verified: boolean;
        authenticationInfo: Record<string, unknown>;
      };
      mocks.verifyAuthenticationResponse.mockClear();
      mocks.verifyAuthenticationResponse.mockResolvedValueOnce(
        'verified' in override
          ? { ...verified, ...override }
          : { ...verified, authenticationInfo: { ...verified.authenticationInfo, ...override } },
      );
      await expect(
        verifyHardwareAssertion({
          response: authenticationResponse(),
          ceremony: ceremony(),
          credential,
          staffId: STAFF_ID,
        }),
      ).rejects.toBeInstanceOf(HardwareAccessVerificationError);
    });
  });
});
