// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-TENANT-RLS-001
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
  mdsSignerHostname: 'mds.fidoalliance.org',
  mdsSignerOrganization: 'Fido Alliance, Inc.',
  mdsSignerIntermediateCn: 'GlobalSign GCC R46 EV TLS CA 2025',
  firmwareExtensionValue: new Uint8Array([0x02, 0x01, 0x2a]) as Uint8Array | undefined,
  firmwareExtensionCritical: false,
  aaguidExtensionValue: new Uint8Array([
    0x04, 0x10, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x4a, 0xaa, 0x8a, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa,
  ]) as Uint8Array | undefined,
  aaguidExtensionCritical: false,
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

    constructor(raw: Uint8Array | ArrayBuffer) {
      this.marker = Buffer.from(raw instanceof Uint8Array ? raw : new Uint8Array(raw)).toString();
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

    getExtension(type: { kind?: string } | string) {
      if (typeof type === 'string') {
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
      if (this.marker === 'mds-intermediate') {
        if (type.kind === 'key-usage') return { usages: 32 | 64 };
        if (type.kind === 'basic-constraints') return { ca: true, critical: true };
        return null;
      }
      if (this.marker !== 'mds-leaf') return null;
      if (type.kind === 'subject-alternative-name') {
        return {
          names: { items: [{ type: 'dns', value: mocks.mdsSignerHostname }] },
        };
      }
      if (type.kind === 'extended-key-usage') return { usages: ['server-auth'] };
      if (type.kind === 'key-usage') return { usages: 1 };
      if (type.kind === 'basic-constraints') return { ca: false };
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

import {
  beginHardwareLogin,
  beginHardwareModeAssertion,
  beginHardwareRegistration,
  consumeHardwareCeremony,
  HardwareAccessVerificationError,
  authenticateStaffHardwareCredential,
  initializeHardwareAccessPolicy,
  lockMatchingHardwareMetadataSerial,
  resetHardwareMetadataCacheForTests,
  type HardwareCeremony,
  verifyHardwareAssertion,
  verifyHardwareRegistration,
} from '../webauthn';

const CEREMONY_ID = 'a'.repeat(32);
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const USER_HANDLE = Buffer.from(STAFF_ID, 'utf8').toString('base64url');
const HARDWARE_AAGUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REJECTED_HARDWARE_AAGUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MDS_BLOB = `${Buffer.from(
  JSON.stringify({
    alg: 'RS256',
    x5c: [
      Buffer.from('mds-leaf').toString('base64'),
      Buffer.from('mds-intermediate').toString('base64'),
    ],
  }),
).toString('base64url')}.payload.signature`;

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
const metadataNextUpdate = new Date('2099-01-01T00:00:00.000Z');

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
  mocks.metadataGetStatement.mockResolvedValue(statement);
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

beforeEach(() => {
  vi.clearAllMocks();
  resetHardwareMetadataCacheForTests();
  mocks.hardwareAaguids.splice(0, Infinity, HARDWARE_AAGUID);
  mocks.hardwarePolicyRevision = 1;
  mocks.mdsSignerHostname = 'mds.fidoalliance.org';
  mocks.mdsSignerOrganization = 'Fido Alliance, Inc.';
  mocks.mdsSignerIntermediateCn = 'GlobalSign GCC R46 EV TLS CA 2025';
  mocks.firmwareExtensionValue = new Uint8Array([0x02, 0x01, 0x2a]);
  mocks.firmwareExtensionCritical = false;
  mocks.aaguidExtensionValue = new Uint8Array([
    0x04, 0x10, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x4a, 0xaa, 0x8a, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa,
  ]);
  mocks.aaguidExtensionCritical = false;
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.redisSet.mockResolvedValue('OK');
  mocks.prismaTransaction.mockImplementation(async (callback: (tx: object) => unknown) =>
    callback({}),
  );
  mocks.metadataInitialize.mockResolvedValue(undefined);
  setMetadataStatus(['FIDO_CERTIFIED_L2']);
  metadataNextUpdate.setTime(new Date('2099-01-01T00:00:00.000Z').getTime());
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => '1024' },
    body: null,
    arrayBuffer: async () => Buffer.from(MDS_BLOB),
  });
  mocks.prismaQueryRaw.mockReset();
  mocks.prismaQueryRaw.mockImplementation(
    (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const bigints = values.filter((value): value is bigint => typeof value === 'bigint');
      const policyHash = values.find(
        (value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
      );
      return Promise.resolve([
        {
          blob_serial: bigints[0] ?? 7n,
          policy_revision: bigints[1] ?? BigInt(mocks.hardwarePolicyRevision),
          policy_hash: policyHash ?? currentPolicyHash(),
        },
      ]);
    },
  );
  mocks.verifyMDSBlob.mockResolvedValue({
    statements: [metadataEntry.metadataStatement],
    parsedNextUpdate: metadataNextUpdate,
    payload: { no: 7, nextUpdate: '2099-01-01', entries: [metadataEntry] },
  });
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

    expect(mocks.verifyMDSBlob).toHaveBeenCalledWith(MDS_BLOB, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.metadataInitialize).toHaveBeenCalledWith({
      mdsServers: [],
      statements: [metadataEntry.metadataStatement],
      verificationMode: 'strict',
    });
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
      mocks.verifyRegistrationResponse.mockImplementationOnce(() => new Promise(() => undefined));
      const attempt = verifyHardwareRegistration({
        response: registrationResponse(),
        ceremony: ceremony('register'),
      });
      const rejected = expect(attempt).rejects.toThrow(/konnte nicht verifiziert/i);
      await vi.waitFor(() => expect(mocks.verifyRegistrationResponse).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      const options = mocks.verifyRegistrationResponse.mock.calls[0]?.[0] as {
        signal?: AbortSignal;
      };
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it('verwirft den Prozess-Cache nach spätestens einer Stunde', async () => {
    await beginHardwareRegistration({
      staffId: STAFF_ID,
      tenantId: '11111111-1111-4111-8111-111111111111',
      authRevision: 4,
      email: 'staff@example.test',
      fullName: 'Staff Test',
      existingCredentials: [],
    });
    mocks.fetch.mockClear();
    mocks.fetch.mockRejectedValueOnce(new Error('MDS offline'));
    vi.useFakeTimers({ now: new Date(Date.now() + 60 * 60 * 1000 + 1) });
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
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('verwirft einen Prozess-Snapshot hinter der persistenten MDS-Seriennummer', async () => {
    await beginHardwareRegistration({
      staffId: STAFF_ID,
      tenantId: '11111111-1111-4111-8111-111111111111',
      authRevision: 4,
      email: 'staff@example.test',
      fullName: 'Staff Test',
      existingCredentials: [],
    });
    mocks.fetch.mockClear();
    mocks.generateRegistrationOptions.mockClear();
    mocks.prismaQueryRaw
      .mockResolvedValueOnce([
        {
          policy_revision: 1n,
          policy_hash: currentPolicyHash(),
        },
      ])
      .mockResolvedValueOnce([
        {
          blob_serial: 999n,
          policy_revision: 1n,
          policy_hash: currentPolicyHash(),
        },
      ]);
    mocks.fetch.mockRejectedValueOnce(new Error('MDS offline'));

    await expect(
      beginHardwareRegistration({
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
        email: 'staff@example.test',
        fullName: 'Staff Test',
        existingCredentials: [],
      }),
    ).rejects.toThrow(/derzeit nicht geprüft/i);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('weist einen zu großen MDS-BLOB bereits beim Streaming-Limit ab', async () => {
    mocks.prismaQueryRaw.mockResolvedValueOnce([
      {
        blob_serial: 999n,
        policy_revision: 1n,
        policy_hash: currentPolicyHash(),
      },
    ]);
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => String(20 * 1024 * 1024 + 1) },
      body: null,
      arrayBuffer: vi.fn(),
    });

    await expect(
      beginHardwareRegistration({
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
        email: 'staff@example.test',
        fullName: 'Staff Test',
        existingCredentials: [],
      }),
    ).rejects.toThrow(/derzeit nicht geprüft/i);
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
  });

  it('verwirft einen abgelaufenen MDS-Snapshot und sperrt bei Refresh-Fehler', async () => {
    metadataNextUpdate.setTime(0);
    mocks.fetch.mockRejectedValueOnce(new Error('MDS offline'));
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

  it('bindet den signierten BLOB an die erwartete FIDO-MDS-Signeridentität', async () => {
    mocks.mdsSignerHostname = 'anderer-global-sign-kunde.example';

    await expect(
      beginHardwareRegistration({
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
        email: 'staff@example.test',
        fullName: 'Staff Test',
        existingCredentials: [],
      }),
    ).rejects.toThrow(/derzeit nicht geprüft/i);
    expect(mocks.verifyMDSBlob).not.toHaveBeenCalled();
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('begrenzt auch eine hängende Signatur-/CRL-Prüfung auf 30 Sekunden', async () => {
    vi.useFakeTimers();
    try {
      mocks.verifyMDSBlob.mockImplementationOnce(() => new Promise(() => undefined));
      const attempt = beginHardwareRegistration({
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
        email: 'staff@example.test',
        fullName: 'Staff Test',
        existingCredentials: [],
      });
      const rejected = expect(attempt).rejects.toThrow(/derzeit nicht geprüft/i);

      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ACCESS-TENANT-RLS-001: beansprucht einen neueren MDS-Stand vor der Allowlist-Auswertung', async () => {
    const rejectedEntry = {
      ...metadataEntry,
      statusReports: [{ status: 'REVOKED', effectiveDate: '2020-01-01' }],
    };
    mocks.verifyMDSBlob.mockResolvedValueOnce({
      statements: [rejectedEntry.metadataStatement],
      parsedNextUpdate: metadataNextUpdate,
      payload: {
        no: 8,
        nextUpdate: '2099-01-01',
        entries: [rejectedEntry],
      },
    });
    mocks.prismaQueryRaw.mockClear();
    mocks.prismaQueryRaw.mockImplementation(
      (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const bigints = values.filter((value): value is bigint => typeof value === 'bigint');
        const policyHash = values.find(
          (value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
        );
        return Promise.resolve([
          {
            blob_serial: bigints[0] ?? 8n,
            policy_revision: bigints[1] ?? 1n,
            policy_hash: policyHash ?? currentPolicyHash(),
          },
        ]);
      },
    );
    mocks.logWarn.mockClear();

    await expect(
      beginHardwareRegistration({
        staffId: STAFF_ID,
        tenantId: '11111111-1111-4111-8111-111111111111',
        authRevision: 4,
        email: 'staff@example.test',
        fullName: 'Staff Test',
        existingCredentials: [],
      }),
    ).rejects.toThrow(/keines der freigegebenen Sicherheitsschlüssel-Modelle/i);

    const claimCallIndex = mocks.prismaQueryRaw.mock.calls.findIndex(([, ...values]) =>
      values.includes(8n),
    );
    expect(claimCallIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.prismaQueryRaw.mock.calls[claimCallIndex]?.[0].join(' ')).toContain(
      'INSERT INTO public."fido_mds_trust_state"',
    );
    expect(mocks.verifyMDSBlob.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.prismaQueryRaw.mock.invocationCallOrder[claimCallIndex]!,
    );
    expect(mocks.prismaQueryRaw.mock.invocationCallOrder[claimCallIndex]).toBeLessThan(
      mocks.logWarn.mock.invocationCallOrder[0]!,
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
    mocks.verifyMDSBlob.mockResolvedValueOnce({
      statements: [metadataEntry.metadataStatement, rejectedEntry.metadataStatement],
      parsedNextUpdate: metadataNextUpdate,
      payload: {
        no: 8,
        nextUpdate: '2099-01-01',
        entries: [metadataEntry, rejectedEntry],
      },
    });
    mocks.prismaQueryRaw.mockImplementation(
      (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const bigints = values.filter((value): value is bigint => typeof value === 'bigint');
        const policyHash = values.find(
          (value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
        );
        return Promise.resolve([
          {
            blob_serial: bigints[0] ?? 8n,
            policy_revision: bigints[1] ?? 1n,
            policy_hash: policyHash ?? currentPolicyHash(),
          },
        ]);
      },
    );

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
      statements: [metadataEntry.metadataStatement],
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
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
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
});
