// =============================================================================
// Hardware-Login (P-23: aus webauthn.ts gelöst)
//
// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-TENANT-RLS-001
//
// Verbraucht die Login-Zeremonie, prüft das gespeicherte Credential gegen den
// aktuellen MDS-Snapshot und committet Zähler, Login und Audit nur unter dem
// exakt geprüften MDS-/Policy-Stand.
// =============================================================================

import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { auditIp } from './login-audit';
import { consumeHardwareCeremony, parseAuthenticationResponse } from './webauthn-ceremony';
import { lockMatchingHardwareMetadataSerial } from './webauthn-metadata';
import { HardwareAccessVerificationError } from './webauthn-shared';
import { verifyHardwareAssertion, type VerifiedHardwareAssertion } from './webauthn-verification';

export type HardwareLoginUser = {
  id: string;
  email: string;
  name: string;
  staffId: string;
  tenantId: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  authMethod: 'security_key';
  authRevision: number;
};

async function recordKnownHardwareLoginFailure(input: {
  tenantId: string;
  staffUserId: string;
  ip: string | null;
}): Promise<void> {
  try {
    await prismaOwner.$transaction(async (tx) => {
      await evidenceService.record(tx, {
        tenantId: input.tenantId,
        actorType: 'STAFF',
        actorId: input.staffUserId,
        action: 'auth.login.failure',
        resourceType: 'staff_user',
        resourceId: input.staffUserId,
        // Absichtlich generisch: weder Credential-ID noch AAGUID, E-Mail oder
        // Verifikationsdetail duerfen zu einem Enumerations-/Geheimnisleck werden.
        after: { method: 'security_key', reason: 'security_key' },
        ip: auditIp(input.ip),
      });
    });
  } catch {
    // Eine nicht verfuegbare Audit-DB darf die ohnehin abgewiesene Anmeldung
    // weder erfolgreich machen noch mit einem unterscheidbaren Fehler versehen.
    log.warn(
      { component: 'staff-webauthn' },
      'Abgewiesene Hardware-Anmeldung konnte nicht auditiert werden',
    );
  }
}

export async function authenticateStaffHardwareCredential(input: {
  ceremonyId: string;
  responseJson: string;
  ip: string | null;
}): Promise<HardwareLoginUser | null> {
  const ceremony = await consumeHardwareCeremony({
    ceremonyId: input.ceremonyId,
    purpose: 'login',
  });
  const response = parseAuthenticationResponse(input.responseJson);
  const credential = await prismaOwner.staffWebAuthnCredential.findUnique({
    where: { credentialId: response.id },
    include: {
      staffUser: {
        include: { roles: true, permissions: true },
      },
    },
  });
  if (!credential) return null;
  if (
    credential.revokedAt ||
    !credential.aaguid ||
    credential.authenticatorVersion === null ||
    !credential.attestationVerifiedAt ||
    credential.attestationFormat !== 'packed' ||
    !credential.staffUser.active ||
    !credential.staffUser.hardwareOnlyEnabledAt ||
    (credential.staffUser.lockedUntil && credential.staffUser.lockedUntil > new Date())
  ) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    return null;
  }

  let assertion: VerifiedHardwareAssertion;
  try {
    assertion = await verifyHardwareAssertion({
      response,
      ceremony,
      credential: {
        id: credential.credentialId,
        aaguid: credential.aaguid,
        publicKey: credential.publicKey,
        signCount: credential.signCount,
        webauthnUserId: credential.webauthnUserId,
        transports: credential.transports,
        deviceType: credential.deviceType,
        backedUp: credential.backedUp,
        attestationFormat: credential.attestationFormat,
        attestationVerifiedAt: credential.attestationVerifiedAt,
        authenticatorVersion: credential.authenticatorVersion,
      },
      staffId: credential.staffUserId,
      requireUserHandle: true,
    });
  } catch (error) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    throw error;
  }

  const now = new Date();
  let committed: boolean;
  try {
    committed = await prismaOwner.$transaction(async (tx) => {
      await lockMatchingHardwareMetadataSerial(tx, assertion.metadataSerial);
      const keyUpdated = await tx.staffWebAuthnCredential.updateMany({
        where: {
          id: credential.id,
          tenantId: credential.tenantId,
          staffUserId: credential.staffUserId,
          revokedAt: null,
          signCount: credential.signCount,
        },
        data: { signCount: assertion.newSignCount, lastUsedAt: now },
      });
      if (keyUpdated.count !== 1) return false;
      const userUpdated = await tx.staffUser.updateMany({
        where: {
          id: credential.staffUserId,
          tenantId: credential.tenantId,
          active: true,
          hardwareOnlyEnabledAt: { not: null },
          authRevision: credential.staffUser.authRevision,
        },
        data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
      });
      // Das Counter-Update muss mit dem Konto-CAS atomar bleiben. Ein bloßes
      // `return false` würde die Transaktion committen und bei einem parallelen
      // Modus-/Revisionwechsel nur den Schlüsselzähler fortschreiben.
      if (userUpdated.count !== 1) throw new HardwareAccessVerificationError();
      await evidenceService.record(tx, {
        tenantId: credential.tenantId,
        actorType: 'STAFF',
        actorId: credential.staffUserId,
        action: 'auth.login.success',
        resourceType: 'staff_user',
        resourceId: credential.staffUserId,
        after: { email: credential.staffUser.email, method: 'security_key' },
        ip: auditIp(input.ip),
      });
      return true;
    });
  } catch (error) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    throw error;
  }
  if (!committed) {
    await recordKnownHardwareLoginFailure({
      tenantId: credential.tenantId,
      staffUserId: credential.staffUserId,
      ip: input.ip,
    });
    return null;
  }

  return {
    id: credential.staffUser.id,
    email: credential.staffUser.email,
    name: credential.staffUser.fullName,
    staffId: credential.staffUser.id,
    tenantId: credential.tenantId,
    fullName: credential.staffUser.fullName,
    roles: credential.staffUser.roles.map((role) => role.role as string),
    permissions: credential.staffUser.permissions.map(
      (permission) => permission.permission as string,
    ),
    authMethod: 'security_key',
    authRevision: credential.staffUser.authRevision,
  };
}
