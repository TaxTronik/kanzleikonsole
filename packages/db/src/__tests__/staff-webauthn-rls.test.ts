// Fachkatalog: ACCESS-TENANT-RLS-001
import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { PrismaClient } from '../prisma-client';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);

if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Staff-WebAuthn-RLS-Tests brauchen DATABASE_URL und DATABASE_APP_URL in CI.');
}

const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantAId: string;
let tenantBId: string;
let staffAId: string;
let staffBId: string;
let adminAId: string;
let partnerAId: string;
let partnerTargetAId: string;
let adminTargetAId: string;
let invariantStaffId: string;
let credentialAId: string;
let credentialBId: string;
let partnerCredentialId: string;
let partnerTargetCredentialId: string;
let adminTargetCredentialId: string;
let invariantCredentialId: string;

async function asActor<T>(
  tenantId: string,
  actorId: string,
  actorType: 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM',
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${actorId}, true),
        set_config('app.current_actor_type', ${actorType}, true)
    `;
    return operation(tx);
  });
}

async function insertCredential(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    staffUserId: string;
    credentialId: string;
    deviceType?: 'singleDevice' | 'multiDevice';
    backedUp?: boolean;
    transports?: string[];
    authenticatorVersion?: bigint | null;
  },
): Promise<void> {
  const authenticatorVersion =
    input.authenticatorVersion === undefined ? 1n : input.authenticatorVersion;
  await tx.$executeRaw`
    INSERT INTO public."staff_webauthn_credential" (
      "tenant_id",
      "staff_user_id",
      "credential_id",
      "public_key",
      "webauthn_user_id",
      "transports",
      "device_type",
      "backed_up",
      "attestation_verified_at",
      "attestation_format",
      "authenticator_version",
      "label"
    ) VALUES (
      ${input.tenantId}::UUID,
      ${input.staffUserId}::UUID,
      ${input.credentialId},
      decode('a1010203', 'hex'),
      ${`user-${input.staffUserId}`},
      ${input.transports ?? ['usb']},
      ${input.deviceType ?? 'singleDevice'},
      ${input.backedUp ?? false},
      CURRENT_TIMESTAMP,
      'packed',
      ${authenticatorVersion}::BIGINT,
      'Test-Sicherheitsschluessel'
    )
  `;
}

async function createHardwareOnlyStaff(role?: 'EMPLOYEE' | 'PARTNER' | 'ADMIN'): Promise<{
  id: string;
  credentialIds: [string, string];
}> {
  const suffix = randomUUID();
  const staff = await owner.staffUser.create({
    data: {
      tenantId: tenantAId,
      email: `staff-webauthn-recovery-${suffix}@example.test`,
      fullName: 'WebAuthn Recovery Target',
      passwordHash: 'test-only-invalid-hash',
      ...(role ? { roles: { create: { role } } } : {}),
    },
  });
  const credentialIds: [string, string] = [
    `recovery-1-${randomUUID()}`,
    `recovery-2-${randomUUID()}`,
  ];
  await owner.$transaction(async (tx) => {
    for (const credentialId of credentialIds) {
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: staff.id,
        credentialId,
      });
    }
    await tx.$executeRaw`
      UPDATE public."staff_user"
         SET "hardware_only_enabled_at" = CURRENT_TIMESTAMP,
             "auth_revision" = "auth_revision" + 1
       WHERE "tenant_id" = ${tenantAId}::UUID
         AND "id" = ${staff.id}::UUID
    `;
  });
  return { id: staff.id, credentialIds };
}

async function recoverCredentialsAs(
  actorId: string,
  targetStaffUserId: string,
  reportBackendPid?: (pid: number) => void,
): Promise<number> {
  return asActor(tenantAId, actorId, 'STAFF', async (tx) => {
    if (reportBackendPid) {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_catalog.pg_backend_pid()::INTEGER AS "pid"
      `;
      reportBackendPid(backend!.pid);
    }
    const [result] = await tx.$queryRaw<Array<{ revokedCount: number }>>`
      SELECT app.revoke_staff_webauthn_credentials_for_recovery(
        ${targetStaffUserId}::UUID
      ) AS "revokedCount"
    `;
    await tx.$executeRaw`
      UPDATE public."staff_user"
         SET "hardware_only_enabled_at" = NULL,
             "auth_revision" = "auth_revision" + 1
       WHERE "tenant_id" = ${tenantAId}::UUID
         AND "id" = ${targetStaffUserId}::UUID
    `;
    return result?.revokedCount ?? 0;
  });
}

async function securityResetCredentialsAs(
  actorId: string,
  targetStaffUserId: string,
  expectedActorAuthRevision: number,
): Promise<number> {
  return asActor(tenantAId, actorId, 'STAFF', async (tx) => {
    const [result] = await tx.$queryRaw<Array<{ revokedCount: number }>>`
      SELECT app.revoke_staff_webauthn_credentials_for_security_reset(
        ${targetStaffUserId}::UUID,
        ${expectedActorAuthRevision}::INTEGER
      ) AS "revokedCount"
    `;
    return result?.revokedCount ?? 0;
  });
}

async function waitForBackendLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await owner.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT COALESCE("wait_event_type" = 'Lock', FALSE) AS "waiting"
        FROM pg_catalog.pg_stat_activity
       WHERE "pid" = ${pid}
    `;
    if (activity?.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describeWithDatabase('Staff-WebAuthn RLS und Hardware-only-Invariante', () => {
  beforeAll(async () => {
    const suffix = `${Date.now()}-${randomUUID()}`;
    const tenantA = await owner.tenant.create({
      data: { slug: `staff-webauthn-a-${suffix}`, name: 'Staff WebAuthn Tenant A' },
    });
    const tenantB = await owner.tenant.create({
      data: { slug: `staff-webauthn-b-${suffix}`, name: 'Staff WebAuthn Tenant B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const [staffA, staffB, adminA, partnerA, partnerTargetA, adminTargetA, invariantStaff] =
      await Promise.all([
        owner.staffUser.create({
          data: {
            tenantId: tenantAId,
            email: `staff-webauthn-a-${suffix}@example.test`,
            fullName: 'WebAuthn Staff A',
            passwordHash: 'test-only-invalid-hash',
          },
        }),
        owner.staffUser.create({
          data: {
            tenantId: tenantBId,
            email: `staff-webauthn-b-${suffix}@example.test`,
            fullName: 'WebAuthn Staff B',
            passwordHash: 'test-only-invalid-hash',
          },
        }),
        owner.staffUser.create({
          data: {
            tenantId: tenantAId,
            email: `staff-webauthn-admin-${suffix}@example.test`,
            fullName: 'WebAuthn Admin A',
            passwordHash: 'test-only-invalid-hash',
            roles: { create: { role: 'ADMIN' } },
          },
        }),
        owner.staffUser.create({
          data: {
            tenantId: tenantAId,
            email: `staff-webauthn-partner-${suffix}@example.test`,
            fullName: 'WebAuthn Partner A',
            passwordHash: 'test-only-invalid-hash',
            roles: { create: { role: 'PARTNER' } },
          },
        }),
        owner.staffUser.create({
          data: {
            tenantId: tenantAId,
            email: `staff-webauthn-partner-target-${suffix}@example.test`,
            fullName: 'WebAuthn Partner Target A',
            passwordHash: 'test-only-invalid-hash',
            roles: { create: { role: 'PARTNER' } },
          },
        }),
        owner.staffUser.create({
          data: {
            tenantId: tenantAId,
            email: `staff-webauthn-admin-target-${suffix}@example.test`,
            fullName: 'WebAuthn Admin Target A',
            passwordHash: 'test-only-invalid-hash',
            roles: { create: { role: 'ADMIN' } },
          },
        }),
        owner.staffUser.create({
          data: {
            tenantId: tenantAId,
            email: `staff-webauthn-invariant-${suffix}@example.test`,
            fullName: 'WebAuthn Invariant Staff',
            passwordHash: 'test-only-invalid-hash',
          },
        }),
      ]);
    staffAId = staffA.id;
    staffBId = staffB.id;
    adminAId = adminA.id;
    partnerAId = partnerA.id;
    partnerTargetAId = partnerTargetA.id;
    adminTargetAId = adminTargetA.id;
    invariantStaffId = invariantStaff.id;
    credentialAId = `cred-a-${randomUUID()}`;
    credentialBId = `cred-b-${randomUUID()}`;
    partnerCredentialId = `cred-partner-${randomUUID()}`;
    partnerTargetCredentialId = `cred-partner-target-${randomUUID()}`;
    adminTargetCredentialId = `cred-admin-target-${randomUUID()}`;
    invariantCredentialId = `invariant-existing-${randomUUID()}`;

    await owner.$transaction(async (tx) => {
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: staffAId,
        credentialId: credentialAId,
      });
      await insertCredential(tx, {
        tenantId: tenantBId,
        staffUserId: staffBId,
        credentialId: credentialBId,
      });
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: invariantStaffId,
        credentialId: invariantCredentialId,
      });
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: partnerAId,
        credentialId: partnerCredentialId,
      });
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: partnerTargetAId,
        credentialId: partnerTargetCredentialId,
      });
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: adminTargetAId,
        credentialId: adminTargetCredentialId,
      });
    });
  });

  afterAll(async () => {
    if (tenantAId && tenantBId) {
      // Die direkte Tenant-FK ist bewusst NO ACTION; der sichere Lebenszyklus
      // laeuft ueber StaffUser -> Credential ON DELETE CASCADE.
      await owner.staffUser.deleteMany({
        where: { tenantId: { in: [tenantAId, tenantBId] } },
      });
      await owner.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    }
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  it('begrenzt Staff auf eigene Credentials und laesst aktive Admins sowie System zu', async () => {
    const ownCredentials = await asActor(
      tenantAId,
      staffAId,
      'STAFF',
      (tx) =>
        tx.$queryRaw<Array<{ credentialId: string }>>`
        SELECT "credential_id" AS "credentialId"
          FROM public."staff_webauthn_credential"
         ORDER BY "credential_id"
      `,
    );
    expect(ownCredentials.map((row) => row.credentialId)).toEqual([credentialAId]);

    const adminCredentials = await asActor(
      tenantAId,
      adminAId,
      'STAFF',
      (tx) =>
        tx.$queryRaw<Array<{ credentialId: string }>>`
        SELECT "credential_id" AS "credentialId"
          FROM public."staff_webauthn_credential"
         ORDER BY "credential_id"
      `,
    );
    expect(adminCredentials.map((row) => row.credentialId)).toEqual(
      [credentialAId, invariantCredentialId, partnerCredentialId, partnerTargetCredentialId].sort(),
    );

    const partnerCredentials = await asActor(
      tenantAId,
      partnerAId,
      'STAFF',
      (tx) =>
        tx.$queryRaw<Array<{ credentialId: string }>>`
        SELECT "credential_id" AS "credentialId"
          FROM public."staff_webauthn_credential"
         ORDER BY "credential_id"
      `,
    );
    expect(partnerCredentials.map((row) => row.credentialId)).toEqual(
      [credentialAId, invariantCredentialId, partnerCredentialId].sort(),
    );

    const systemCredentials = await asActor(
      tenantBId,
      staffBId,
      'SYSTEM',
      (tx) =>
        tx.$queryRaw<Array<{ credentialId: string }>>`
        SELECT "credential_id" AS "credentialId"
          FROM public."staff_webauthn_credential"
      `,
    );
    expect(systemCredentials.map((row) => row.credentialId)).toEqual([credentialBId]);

    const portalCredentials = await asActor(
      tenantAId,
      staffAId,
      'CLIENT_CONTACT',
      (tx) =>
        tx.$queryRaw<Array<{ credentialId: string }>>`
        SELECT "credential_id" AS "credentialId"
          FROM public."staff_webauthn_credential"
      `,
    );
    expect(portalCredentials).toEqual([]);

    await owner.staffUser.update({ where: { id: adminAId }, data: { active: false } });
    const inactiveAdminCredentials = await asActor(
      tenantAId,
      adminAId,
      'STAFF',
      (tx) =>
        tx.$queryRaw<Array<{ credentialId: string }>>`
        SELECT "credential_id" AS "credentialId"
          FROM public."staff_webauthn_credential"
      `,
    );
    expect(inactiveAdminCredentials).toEqual([]);
    await owner.staffUser.update({ where: { id: adminAId }, data: { active: true } });
  });

  it('beschraenkt direkte Credential-Mutationen auf das eigene Konto', async () => {
    const ownChanged = await asActor(
      tenantAId,
      staffAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Eigene Schluesselbezeichnung'
         WHERE "credential_id" = ${credentialAId}
      `,
    );
    expect(ownChanged).toBe(1);

    const partnerChangedEmployee = await asActor(
      tenantAId,
      partnerAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Partner-Recovery fuer Employee'
         WHERE "credential_id" = ${credentialAId}
      `,
    );
    expect(partnerChangedEmployee).toBe(0);

    const partnerChangedPartner = await asActor(
      tenantAId,
      partnerAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Unzulaessige Partner-Recovery'
         WHERE "credential_id" = ${partnerTargetCredentialId}
      `,
    );
    expect(partnerChangedPartner).toBe(0);

    const partnerChangedAdmin = await asActor(
      tenantAId,
      partnerAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Unzulaessige Admin-Recovery'
         WHERE "credential_id" = ${adminTargetCredentialId}
      `,
    );
    expect(partnerChangedAdmin).toBe(0);

    const adminChangedPartner = await asActor(
      tenantAId,
      adminAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Admin-Recovery fuer Partner'
         WHERE "credential_id" = ${partnerTargetCredentialId}
      `,
    );
    expect(adminChangedPartner).toBe(0);

    const adminChangedAdmin = await asActor(
      tenantAId,
      adminAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Unzulaessige Admin-UI-Recovery'
         WHERE "credential_id" = ${adminTargetCredentialId}
      `,
    );
    expect(adminChangedAdmin).toBe(0);
  });

  it('erzwingt die Recovery-Hierarchie in der schmalen Widerrufsprozedur', async () => {
    const employeeTarget = await createHardwareOnlyStaff('EMPLOYEE');
    await expect(recoverCredentialsAs(partnerAId, employeeTarget.id)).resolves.toBe(2);

    const employeeState = await owner.staffWebAuthnCredential.findMany({
      where: { staffUserId: employeeTarget.id },
      select: { revokedAt: true },
    });
    expect(employeeState).toHaveLength(2);
    expect(employeeState.every((credential) => credential.revokedAt instanceof Date)).toBe(true);

    const partnerTarget = await createHardwareOnlyStaff('PARTNER');
    await expect(recoverCredentialsAs(partnerAId, partnerTarget.id)).rejects.toThrow(
      /Recovery-Hierarchie/i,
    );
    await expect(recoverCredentialsAs(adminAId, partnerTarget.id)).resolves.toBe(2);

    const adminTarget = await createHardwareOnlyStaff('ADMIN');
    await expect(recoverCredentialsAs(adminAId, adminTarget.id)).rejects.toThrow(
      /Recovery-Hierarchie/i,
    );
  });

  it('verweigert die Recovery-Prozedur normalem Staff und dem Ziel selbst', async () => {
    const target = await createHardwareOnlyStaff('EMPLOYEE');

    await expect(recoverCredentialsAs(staffAId, target.id)).rejects.toThrow(
      /Hardware-Recovery ist fuer diesen Akteur nicht zulaessig/i,
    );
    await expect(recoverCredentialsAs(target.id, target.id)).rejects.toThrow(
      /eigene Hardware-Zugang/i,
    );
  });

  it('verhindert Rollen-Demotion als Umgehung der Recovery-Hierarchie', async () => {
    await expect(
      asActor(tenantAId, adminAId, 'STAFF', (tx) =>
        tx.staffRole.deleteMany({
          where: { staffUserId: adminTargetAId, role: 'ADMIN' },
        }),
      ),
    ).rejects.toThrow(/ADMIN-Rolle.*Staff-Akteur.*nicht entzogen/i);

    await expect(
      asActor(tenantAId, partnerAId, 'STAFF', (tx) =>
        tx.staffRole.deleteMany({
          where: { staffUserId: partnerTargetAId, role: 'PARTNER' },
        }),
      ),
    ).rejects.toThrow(/PARTNER-Rolle.*aktiven ADMIN/i);

    const removedByAdmin = await asActor(tenantAId, adminAId, 'STAFF', (tx) =>
      tx.staffRole.deleteMany({
        where: { staffUserId: partnerTargetAId, role: 'PARTNER' },
      }),
    );
    expect(removedByAdmin.count).toBe(1);
    await owner.staffRole.create({
      data: { staffUserId: partnerTargetAId, role: 'PARTNER' },
    });
  });

  it('widerruft dormant Hardware-Credentials beim Sicherheitsreset und bindet die Actor-Revision', async () => {
    const suffix = randomUUID();
    const firstTarget = await owner.staffUser.create({
      data: {
        tenantId: tenantAId,
        email: `staff-webauthn-security-reset-${suffix}@example.test`,
        fullName: 'WebAuthn Security Reset Target',
        passwordHash: 'test-only-invalid-hash',
        roles: { create: { role: 'EMPLOYEE' } },
      },
    });
    const staleTarget = await owner.staffUser.create({
      data: {
        tenantId: tenantAId,
        email: `staff-webauthn-security-reset-stale-${suffix}@example.test`,
        fullName: 'WebAuthn Stale Security Reset Target',
        passwordHash: 'test-only-invalid-hash',
        roles: { create: { role: 'EMPLOYEE' } },
      },
    });
    await owner.$transaction(async (tx) => {
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: firstTarget.id,
        credentialId: `security-reset-${randomUUID()}`,
      });
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: staleTarget.id,
        credentialId: `security-reset-stale-${randomUUID()}`,
      });
    });
    const actor = await owner.staffUser.findUniqueOrThrow({
      where: { id: adminAId },
      select: { authRevision: true },
    });

    await expect(
      securityResetCredentialsAs(adminAId, firstTarget.id, actor.authRevision),
    ).resolves.toBe(1);
    expect(
      await owner.staffWebAuthnCredential.count({
        where: { staffUserId: firstTarget.id, revokedAt: null },
      }),
    ).toBe(0);

    await expect(
      securityResetCredentialsAs(adminAId, staleTarget.id, actor.authRevision + 1),
    ).rejects.toThrow(/Sicherheitsreset.*nicht zulaessig/i);
    expect(
      await owner.staffWebAuthnCredential.count({
        where: { staffUserId: staleTarget.id, revokedAt: null },
      }),
    ).toBe(1);
  });

  it('hat erzwungenes RLS, eine Policy und nur die benoetigten Tabellenrechte', async () => {
    const [security] = await owner.$queryRaw<
      Array<{
        rlsEnabled: boolean;
        rlsForced: boolean;
        policyCount: number;
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canTruncate: boolean;
      }>
    >`
      SELECT
        relation.relrowsecurity AS "rlsEnabled",
        relation.relforcerowsecurity AS "rlsForced",
        (
          SELECT COUNT(*)::INTEGER
            FROM pg_catalog.pg_policy policy
           WHERE policy.polrelid = relation.oid
        ) AS "policyCount",
        has_table_privilege(
          'taxtronik_app', 'public.staff_webauthn_credential', 'SELECT'
        ) AS "canSelect",
        has_table_privilege(
          'taxtronik_app', 'public.staff_webauthn_credential', 'INSERT'
        ) AS "canInsert",
        has_table_privilege(
          'taxtronik_app', 'public.staff_webauthn_credential', 'UPDATE'
        ) AS "canUpdate",
        has_table_privilege(
          'taxtronik_app', 'public.staff_webauthn_credential', 'DELETE'
        ) AS "canDelete",
        has_table_privilege(
          'taxtronik_app', 'public.staff_webauthn_credential', 'TRUNCATE'
        ) AS "canTruncate"
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'staff_webauthn_credential'
    `;

    expect(security).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      policyCount: 3,
      canSelect: true,
      canInsert: true,
      canUpdate: true,
      canDelete: false,
      canTruncate: false,
    });
  });

  it('haelt den globalen MDS-Serienanker vollstaendig ausserhalb der App-Rolle', async () => {
    const [privileges] = await owner.$queryRaw<
      Array<{ canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean }>
    >`
      SELECT
        has_table_privilege(
          'taxtronik_app', 'public.fido_mds_trust_state', 'SELECT'
        ) AS "canSelect",
        has_table_privilege(
          'taxtronik_app', 'public.fido_mds_trust_state', 'INSERT'
        ) AS "canInsert",
        has_table_privilege(
          'taxtronik_app', 'public.fido_mds_trust_state', 'UPDATE'
        ) AS "canUpdate",
        has_table_privilege(
          'taxtronik_app', 'public.fido_mds_trust_state', 'DELETE'
        ) AS "canDelete"
    `;
    expect(privileges).toEqual({
      canSelect: false,
      canInsert: false,
      canUpdate: false,
      canDelete: false,
    });

    await expect(
      app.$queryRaw`SELECT "blob_serial" FROM public."fido_mds_trust_state"`,
    ).rejects.toThrow(/permission denied/i);
  });

  it('bindet einen App-Commit bis Transaktionsende an die exakt gepruefte MDS-Serie', async () => {
    await owner.$executeRaw`
      INSERT INTO public."fido_mds_trust_state" (
        "singleton", "blob_serial", "next_update", "verified_at",
        "policy_revision", "policy_hash"
      ) VALUES (
        TRUE, 1, CURRENT_DATE + 1, CURRENT_TIMESTAMP,
        1, ${'a'.repeat(64)}
      )
      ON CONFLICT ("singleton") DO UPDATE
        SET "blob_serial" = CASE
              WHEN public."fido_mds_trust_state"."blob_serial" = 0 THEN 1
              ELSE public."fido_mds_trust_state"."blob_serial"
            END
    `;
    const [state] = await owner.$queryRaw<
      Array<{ blobSerial: bigint; policyRevision: bigint; policyHash: string }>
    >`
      SELECT
        "blob_serial" AS "blobSerial",
        "policy_revision" AS "policyRevision",
        "policy_hash" AS "policyHash"
        FROM public."fido_mds_trust_state"
       WHERE "singleton" = TRUE
    `;
    const expectedSerial = state!.blobSerial;
    const expectedPolicyRevision = state!.policyRevision;
    const expectedPolicyHash = state!.policyHash;

    let releaseGuard!: () => void;
    let guardLocked!: () => void;
    let reportUpdaterPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      guardLocked = resolve;
    });
    const updaterPid = new Promise<number>((resolve) => {
      reportUpdaterPid = resolve;
    });

    const guardedCommit = asActor(tenantAId, staffAId, 'STAFF', async (tx) => {
      const [result] = await tx.$queryRaw<Array<{ matches: boolean }>>`
        SELECT app.lock_matching_fido_mds_state(
          ${expectedSerial},
          ${expectedPolicyRevision},
          ${expectedPolicyHash}
        ) AS "matches"
      `;
      guardLocked();
      await release;
      return result?.matches;
    });
    await locked;

    const concurrentRefresh = owner.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_catalog.pg_backend_pid()::INTEGER AS "pid"
        `;
        reportUpdaterPid(backend!.pid);
        await tx.$executeRaw`
          UPDATE public."fido_mds_trust_state"
             SET "verified_at" = CURRENT_TIMESTAMP
           WHERE "singleton" = TRUE
        `;
      },
      { timeout: 10_000 },
    );

    try {
      expect(await waitForBackendLock(await updaterPid)).toBe(true);
    } finally {
      releaseGuard();
    }
    await expect(guardedCommit).resolves.toBe(true);
    await expect(concurrentRefresh).resolves.toBeUndefined();

    await expect(
      asActor(tenantAId, staffAId, 'STAFF', async (tx) => {
        const [result] = await tx.$queryRaw<Array<{ matches: boolean | null }>>`
          SELECT app.lock_matching_fido_mds_state(
            ${expectedSerial + 1n},
            ${expectedPolicyRevision},
            ${expectedPolicyHash}
          ) AS "matches"
        `;
        return result?.matches;
      }),
    ).resolves.toBe(false);

    await expect(
      asActor(tenantAId, staffAId, 'STAFF', async (tx) => {
        const [result] = await tx.$queryRaw<Array<{ matches: boolean | null }>>`
          SELECT app.lock_matching_fido_mds_state(
            ${expectedSerial},
            ${expectedPolicyRevision + 1n},
            ${expectedPolicyHash}
          ) AS "matches"
        `;
        return result?.matches;
      }),
    ).resolves.toBe(false);

    await expect(
      asActor(tenantAId, staffAId, 'STAFF', async (tx) => {
        const [result] = await tx.$queryRaw<Array<{ matches: boolean | null }>>`
          SELECT app.lock_matching_fido_mds_state(
            ${expectedSerial},
            ${expectedPolicyRevision},
            ${'b'.repeat(64)}
          ) AS "matches"
        `;
        return result?.matches;
      }),
    ).resolves.toBe(false);
  }, 15_000);

  it('blockiert Cross-Tenant-INSERT/UPDATE und verweigert physische DELETEs', async () => {
    await expect(
      asActor(tenantAId, staffAId, 'STAFF', (tx) =>
        insertCredential(tx, {
          tenantId: tenantBId,
          staffUserId: staffBId,
          credentialId: `cross-insert-${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asActor(tenantAId, partnerAId, 'STAFF', (tx) =>
        insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: staffAId,
          credentialId: `partner-foreign-insert-${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asActor(tenantAId, adminAId, 'STAFF', (tx) =>
        insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: partnerTargetAId,
          credentialId: `admin-foreign-insert-${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asActor(tenantAId, staffAId, 'CLIENT_CONTACT', (tx) =>
        insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: staffAId,
          credentialId: `portal-insert-${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow();

    const sameTenantPeerUpdated = await asActor(
      tenantAId,
      staffAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Unzulaessige Peer-Aenderung'
         WHERE "credential_id" = ${invariantCredentialId}
      `,
    );
    expect(sameTenantPeerUpdated).toBe(0);

    const updated = await asActor(
      tenantAId,
      staffAId,
      'STAFF',
      (tx) =>
        tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "label" = 'Cross-Tenant-Aenderung'
         WHERE "credential_id" = ${credentialBId}
      `,
    );
    expect(updated).toBe(0);

    await expect(
      asActor(
        tenantAId,
        staffAId,
        'STAFF',
        (tx) =>
          tx.$executeRaw`
          DELETE FROM public."staff_webauthn_credential"
           WHERE "credential_id" = ${credentialBId}
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('lehnt eine Cross-Tenant-Staff-Zuordnung auch fuer den Owner per Composite-FK ab', async () => {
    await expect(
      owner.$transaction((tx) =>
        insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: staffBId,
          credentialId: `cross-parent-${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow();
  });

  it('aktiviert Hardware-only erst atomar mit zwei geeigneten Credentials', async () => {
    await expect(
      owner.$executeRaw`
        UPDATE public."staff_user"
           SET "hardware_only_enabled_at" = CURRENT_TIMESTAMP
         WHERE "tenant_id" = ${tenantAId}::UUID
           AND "id" = ${invariantStaffId}::UUID
      `,
    ).rejects.toThrow(/mindestens zwei aktive, geraetegebundene Sicherheitsschluessel/i);

    await expect(
      owner.$transaction(async (tx) => {
        await insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: invariantStaffId,
          credentialId: `invariant-internal-${randomUUID()}`,
          transports: ['internal'],
        });
        await tx.$executeRaw`
          UPDATE public."staff_user"
             SET "hardware_only_enabled_at" = CURRENT_TIMESTAMP
           WHERE "tenant_id" = ${tenantAId}::UUID
             AND "id" = ${invariantStaffId}::UUID
        `;
      }),
    ).rejects.toThrow(/mindestens zwei aktive, geraetegebundene Sicherheitsschluessel/i);

    const second = `invariant-second-${randomUUID()}`;
    await owner.$transaction(async (tx) => {
      await insertCredential(tx, {
        tenantId: tenantAId,
        staffUserId: invariantStaffId,
        credentialId: second,
      });
      await tx.$executeRaw`
        UPDATE public."staff_user"
           SET "hardware_only_enabled_at" = CURRENT_TIMESTAMP,
               "auth_revision" = "auth_revision" + 1
         WHERE "tenant_id" = ${tenantAId}::UUID
           AND "id" = ${invariantStaffId}::UUID
      `;
    });

    const enabled = await owner.$queryRaw<
      Array<{ hardwareOnlyEnabledAt: Date | null; authRevision: number }>
    >`
      SELECT
        "hardware_only_enabled_at" AS "hardwareOnlyEnabledAt",
        "auth_revision" AS "authRevision"
      FROM public."staff_user"
      WHERE "id" = ${invariantStaffId}::UUID
    `;
    expect(enabled[0]?.hardwareOnlyEnabledAt).toBeInstanceOf(Date);
    expect(enabled[0]?.authRevision).toBe(1);

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "revoked_at" = CURRENT_TIMESTAMP
         WHERE "credential_id" = ${invariantCredentialId}
      `,
    ).rejects.toThrow(/mindestens zwei aktive, geraetegebundene Sicherheitsschluessel/i);

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "device_type" = 'multiDevice'
         WHERE "credential_id" = ${invariantCredentialId}
      `,
    ).rejects.toThrow(/Credential-Identitaet ist unveraenderlich/i);

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE public."staff_user"
           SET "hardware_only_enabled_at" = NULL,
               "auth_revision" = "auth_revision" + 1
         WHERE "tenant_id" = ${tenantAId}::UUID
           AND "id" = ${invariantStaffId}::UUID
      `;
      await tx.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "revoked_at" = CURRENT_TIMESTAMP
         WHERE "tenant_id" = ${tenantAId}::UUID
           AND "staff_user_id" = ${invariantStaffId}::UUID
      `;
    });
  });

  it('serialisiert parallele Widerrufe und laesst genau zwei aktive Schluessel uebrig', async () => {
    const suffix = randomUUID();
    const raceStaff = await owner.staffUser.create({
      data: {
        tenantId: tenantAId,
        email: `staff-webauthn-race-${suffix}@example.test`,
        fullName: 'WebAuthn Race Staff',
        passwordHash: 'test-only-invalid-hash',
      },
    });
    const raceCredentials = [0, 1, 2].map((position) => `race-${position}-${randomUUID()}`);
    await owner.$transaction(async (tx) => {
      for (const credentialId of raceCredentials) {
        await insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: raceStaff.id,
          credentialId,
        });
      }
      await tx.$executeRaw`
        UPDATE public."staff_user"
           SET "hardware_only_enabled_at" = CURRENT_TIMESTAMP,
               "auth_revision" = "auth_revision" + 1
         WHERE "id" = ${raceStaff.id}::UUID
      `;
    });

    let releaseFirst!: () => void;
    let firstUpdated!: () => void;
    let reportSecondPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      firstUpdated = resolve;
    });
    const secondPid = new Promise<number>((resolve) => {
      reportSecondPid = resolve;
    });

    const firstRevocation = owner.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE public."staff_webauthn_credential"
             SET "revoked_at" = CURRENT_TIMESTAMP
           WHERE "credential_id" = ${raceCredentials[0]!}
        `;
        firstUpdated();
        await release;
      },
      { timeout: 10_000 },
    );

    await updated;
    const secondRevocation = owner.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_catalog.pg_backend_pid()::INTEGER AS "pid"
        `;
        reportSecondPid(backend!.pid);
        await tx.$executeRaw`
          UPDATE public."staff_webauthn_credential"
             SET "revoked_at" = CURRENT_TIMESTAMP
           WHERE "credential_id" = ${raceCredentials[1]!}
        `;
      },
      { timeout: 10_000 },
    );

    try {
      expect(await waitForBackendLock(await secondPid)).toBe(true);
    } finally {
      releaseFirst();
    }

    await expect(firstRevocation).resolves.toBeUndefined();
    await expect(secondRevocation).rejects.toThrow(
      /mindestens zwei aktive, geraetegebundene Sicherheitsschluessel/i,
    );

    const [remaining] = await owner.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::INTEGER AS "count"
        FROM public."staff_webauthn_credential"
       WHERE "tenant_id" = ${tenantAId}::UUID
         AND "staff_user_id" = ${raceStaff.id}::UUID
         AND "revoked_at" IS NULL
         AND "device_type" = 'singleDevice'
         AND "backed_up" = FALSE
         AND "attestation_verified_at" IS NOT NULL
         AND pg_catalog.cardinality("transports") > 0
         AND "transports" <@ ARRAY['ble', 'nfc', 'smart-card', 'usb']::TEXT[]
    `;
    expect(remaining?.count).toBe(2);
  }, 15_000);

  it('serialisiert Rollen-Insert und Recovery-Read ueber denselben DB-Lock', async () => {
    const suffix = randomUUID();
    const target = await owner.staffUser.create({
      data: {
        tenantId: tenantAId,
        email: `staff-webauthn-role-race-${suffix}@example.test`,
        fullName: 'WebAuthn Role Race Staff',
        passwordHash: 'test-only-invalid-hash',
        roles: { create: { role: 'EMPLOYEE' } },
      },
    });

    let releaseRoleInsert!: () => void;
    let roleInserted!: () => void;
    let reportRecoveryPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseRoleInsert = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      roleInserted = resolve;
    });
    const recoveryPid = new Promise<number>((resolve) => {
      reportRecoveryPid = resolve;
    });

    const roleChange = owner.$transaction(
      async (tx) => {
        await tx.staffRole.create({
          data: { staffUserId: target.id, role: 'PARTNER' },
        });
        roleInserted();
        await release;
      },
      { timeout: 10_000 },
    );

    await inserted;
    const recoveryRead = app.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT
            set_config('app.current_tenant_id', ${tenantAId}, true),
            set_config('app.current_actor_id', ${adminAId}, true),
            set_config('app.current_actor_type', 'STAFF', true)
        `;
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_catalog.pg_backend_pid()::INTEGER AS "pid"
        `;
        reportRecoveryPid(backend!.pid);
        await tx.$queryRaw`
          SELECT app.lock_staff_account_recovery(${target.id}::UUID)::TEXT AS "locked"
        `;
        return tx.staffRole.findMany({
          where: { staffUserId: target.id },
          select: { role: true },
        });
      },
      { timeout: 10_000 },
    );

    try {
      expect(await waitForBackendLock(await recoveryPid)).toBe(true);
    } finally {
      releaseRoleInsert();
    }

    await expect(roleChange).resolves.toBeUndefined();
    await expect(recoveryRead).resolves.toEqual(
      expect.arrayContaining([{ role: 'EMPLOYEE' }, { role: 'PARTNER' }]),
    );
  }, 15_000);

  it('entscheidet die Recovery-Hierarchie erst nach einem parallelen Ziel-Rollenwechsel', async () => {
    const target = await createHardwareOnlyStaff('EMPLOYEE');
    let releaseRoleInsert!: () => void;
    let roleInserted!: () => void;
    let reportRecoveryPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseRoleInsert = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      roleInserted = resolve;
    });
    const recoveryPid = new Promise<number>((resolve) => {
      reportRecoveryPid = resolve;
    });

    const roleChange = owner.$transaction(
      async (tx) => {
        await tx.staffRole.create({
          data: { staffUserId: target.id, role: 'PARTNER' },
        });
        roleInserted();
        await release;
      },
      { timeout: 10_000 },
    );

    await inserted;
    const recovery = recoverCredentialsAs(partnerAId, target.id, reportRecoveryPid);

    try {
      expect(await waitForBackendLock(await recoveryPid)).toBe(true);
    } finally {
      releaseRoleInsert();
    }

    await expect(roleChange).resolves.toBeUndefined();
    await expect(recovery).rejects.toThrow(/Recovery-Hierarchie/i);

    const activeCredentials = await owner.staffWebAuthnCredential.count({
      where: { staffUserId: target.id, revokedAt: null },
    });
    expect(activeCredentials).toBe(2);
  }, 15_000);

  it('verwirft Recovery nach parallel committed Actor-Deaktivierung', async () => {
    const suffix = randomUUID();
    const actor = await owner.staffUser.create({
      data: {
        tenantId: tenantAId,
        email: `staff-webauthn-disabled-actor-${suffix}@example.test`,
        fullName: 'WebAuthn Disabled Recovery Actor',
        passwordHash: 'test-only-invalid-hash',
        roles: { create: { role: 'PARTNER' } },
      },
    });
    const target = await createHardwareOnlyStaff('EMPLOYEE');
    let releaseDeactivation!: () => void;
    let actorDeactivated!: () => void;
    let reportRecoveryPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseDeactivation = resolve;
    });
    const deactivated = new Promise<void>((resolve) => {
      actorDeactivated = resolve;
    });
    const recoveryPid = new Promise<number>((resolve) => {
      reportRecoveryPid = resolve;
    });

    const deactivation = owner.$transaction(
      async (tx) => {
        await tx.staffUser.update({
          where: { id: actor.id },
          data: { active: false },
        });
        actorDeactivated();
        await release;
      },
      { timeout: 10_000 },
    );

    await deactivated;
    const recovery = recoverCredentialsAs(actor.id, target.id, reportRecoveryPid);

    try {
      expect(await waitForBackendLock(await recoveryPid)).toBe(true);
    } finally {
      releaseDeactivation();
    }

    await expect(deactivation).resolves.toBeUndefined();
    await expect(recovery).rejects.toThrow(
      /Hardware-Recovery ist fuer diesen Akteur nicht zulaessig/i,
    );

    const activeCredentials = await owner.staffWebAuthnCredential.count({
      where: { staffUserId: target.id, revokedAt: null },
    });
    expect(activeCredentials).toBe(2);
  }, 15_000);

  it('weist negative Auth-Revisionen und Signaturzaehler per CHECK ab', async () => {
    await expect(
      owner.$executeRaw`
        UPDATE public."staff_user"
           SET "auth_revision" = -1
         WHERE "id" = ${staffAId}::UUID
      `,
    ).rejects.toThrow();

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "sign_count" = -1
         WHERE "credential_id" = ${credentialAId}
      `,
    ).rejects.toThrow();
  });

  it('begrenzt die attestierte Authenticator-Version auf uint32', async () => {
    await expect(
      owner.$transaction((tx) =>
        insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: staffAId,
          credentialId: `invalid-version-negative-${randomUUID()}`,
          authenticatorVersion: -1n,
        }),
      ),
    ).rejects.toThrow();

    await expect(
      owner.$transaction((tx) =>
        insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: staffAId,
          credentialId: `invalid-version-overflow-${randomUUID()}`,
          authenticatorVersion: 4_294_967_296n,
        }),
      ),
    ).rejects.toThrow();

    await expect(
      owner.$transaction((tx) =>
        insertCredential(tx, {
          tenantId: tenantAId,
          staffUserId: staffAId,
          credentialId: `legacy-version-null-${randomUUID()}`,
          authenticatorVersion: null,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('macht sicherheitsentscheidende Credential-Klassifizierung unveraenderlich', async () => {
    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "transports" = ARRAY['internal']::TEXT[]
         WHERE "credential_id" = ${credentialAId}
      `,
    ).rejects.toThrow(/Credential-Identitaet ist unveraenderlich/i);

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "device_type" = 'multiDevice'
         WHERE "credential_id" = ${credentialAId}
      `,
    ).rejects.toThrow(/Credential-Identitaet ist unveraenderlich/i);

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "backed_up" = TRUE,
               "device_type" = 'multiDevice'
         WHERE "credential_id" = ${credentialAId}
      `,
    ).rejects.toThrow(/Credential-Identitaet ist unveraenderlich/i);

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "attestation_format" = 'none'
         WHERE "credential_id" = ${credentialAId}
      `,
    ).rejects.toThrow(/Credential-Identitaet ist unveraenderlich/i);

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "attestation_verified_at" = "attestation_verified_at" + INTERVAL '1 second'
         WHERE "credential_id" = ${credentialAId}
      `,
    ).rejects.toThrow(/Credential-Identitaet ist unveraenderlich/i);

    await expect(
      owner.$executeRaw`
        UPDATE public."staff_webauthn_credential"
           SET "authenticator_version" = 2
         WHERE "credential_id" = ${credentialAId}
      `,
    ).rejects.toThrow(/Credential-Identitaet ist unveraenderlich/i);
  });
});
