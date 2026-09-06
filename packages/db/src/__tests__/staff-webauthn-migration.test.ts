// Fachkatalog: ACCESS-TENANT-RLS-001
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903000000_staff_hardware_only_access/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const leastPrivilegeMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903001000_staff_webauthn_least_privilege/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const hardeningMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903002000_staff_webauthn_hardening/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const recoveryHierarchyMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903003000_staff_webauthn_recovery_hierarchy/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const recoveryProcedureMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903004000_staff_webauthn_recovery_procedure/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const authenticatorVersionMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903005000_staff_webauthn_authenticator_version/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const mdsTrustStateMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903006000_fido_mds_trust_state/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const mdsCommitGuardMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903007000_fido_mds_commit_guard/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const mdsPolicyBindingMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903008000_fido_mds_policy_binding/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const recoveryRoleFloorMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903009000_staff_recovery_role_floor/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const securityResetCredentialMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260903010000_staff_security_reset_credential_revocation/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const rlsVerifier = readFileSync(new URL('../../scripts/verify-rls.ts', import.meta.url), 'utf8');

describe('Staff-WebAuthn-Datenbankvertrag', () => {
  it('bindet Credentials per Tenant-/Staff-Composite-Relation', () => {
    expect(schema).toContain('model StaffWebAuthnCredential {');
    expect(schema).toContain('staffHardwareCredentials       StaffWebAuthnCredential[]');
    expect(schema).toContain('hardwareCredentials             StaffWebAuthnCredential[]');
    expect(schema).toContain('@@unique([tenantId, id])');
    expect(schema).toContain(
      '@relation(fields: [tenantId, staffUserId], references: [tenantId, id],',
    );

    expect(migration).toContain('CONSTRAINT "staff_user_tenant_id_id_key"');
    expect(migration).toContain('FOREIGN KEY ("tenant_id", "staff_user_id")');
    expect(migration).toContain('REFERENCES public."staff_user"("tenant_id", "id")');
  });

  it('erzwingt nichtnegative Revisions- und Signaturzaehler', () => {
    expect(schema).toContain('authRevision                    Int');
    expect(schema).toContain('@default(0) @map("auth_revision")');
    expect(schema).toMatch(/signCount\s+BigInt\s+@default\(0\) @map\("sign_count"\)/);
    expect(schema).toMatch(/attestationVerifiedAt\s+DateTime\s+@map\("attestation_verified_at"\)/);
    expect(schema).toMatch(
      /attestationFormat\s+String\s+@map\("attestation_format"\) @db\.VarChar\(32\)/,
    );
    expect(schema).toMatch(/authenticatorVersion\s+BigInt\?\s+@map\("authenticator_version"\)/);
    expect(migration).toContain('CHECK ("auth_revision" >= 0)');
    expect(migration).toContain('CHECK ("sign_count" >= 0)');
  });

  it('isoliert die Credential-Tabelle mit ENABLE und FORCE RLS vom Portal', () => {
    expect(migration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(migration).toContain(
      'ALTER TABLE public."staff_webauthn_credential" ENABLE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain(
      'ALTER TABLE public."staff_webauthn_credential" FORCE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain('"tenant_id" = app.current_tenant_id()');
    expect(migration).toContain("app.current_actor_type() IN ('STAFF', 'SYSTEM')");
    expect(migration).toContain(
      'REVOKE ALL ON public."staff_webauthn_credential" FROM taxtronik_app;',
    );
    expect(migration).toContain('ON public."staff_webauthn_credential" TO taxtronik_app;');
    expect(leastPrivilegeMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(leastPrivilegeMigration).toContain('SECURITY DEFINER');
    expect(leastPrivilegeMigration).toContain('actor."active" = TRUE');
    expect(leastPrivilegeMigration).toContain("actor_role.\"role\" IN ('ADMIN', 'PARTNER')");
    expect(leastPrivilegeMigration).toContain('actor."id" = credential_staff_user_id');
    expect(leastPrivilegeMigration).toContain(
      'REVOKE ALL ON FUNCTION app.staff_webauthn_credential_access_allowed(UUID, UUID)',
    );
    expect(leastPrivilegeMigration).toContain(
      'CREATE POLICY "staff_webauthn_credential_least_privilege"',
    );
    expect(leastPrivilegeMigration).toContain('SET search_path = pg_catalog, pg_temp');
  });

  it('prueft die Zwei-Schluessel-Invariante deferred und race-sicher', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION app.lock_staff_hardware_auth_state()');
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock(');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.enforce_staff_hardware_key_minimum()',
    );
    expect(migration).toContain('credential."revoked_at" IS NULL');
    expect(migration).toContain('credential."device_type" = \'singleDevice\'');
    expect(migration).toContain('credential."backed_up" = FALSE');
    expect(migration).toContain('IF eligible_credentials < 2 THEN');
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2);
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.enforce_staff_hardware_key_minimum() FROM taxtronik_app;',
    );
  });

  it('haertet physische Transportklassifikation und Tabellenrechte vorwaerts', () => {
    expect(hardeningMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(hardeningMigration).toContain(
      'CREATE OR REPLACE FUNCTION app.enforce_staff_hardware_key_minimum()',
    );
    expect(hardeningMigration).toContain('pg_catalog.cardinality(credential."transports") > 0');
    expect(hardeningMigration).toContain(
      "credential.\"transports\" <@ ARRAY['ble', 'nfc', 'smart-card', 'usb']::TEXT[]",
    );
    expect(hardeningMigration).toContain('NEW."transports" IS DISTINCT FROM OLD."transports"');
    expect(hardeningMigration).toContain('NEW."device_type" IS DISTINCT FROM OLD."device_type"');
    expect(hardeningMigration).toContain('NEW."backed_up" IS DISTINCT FROM OLD."backed_up"');
    expect(hardeningMigration).toContain(
      'REVOKE DELETE ON TABLE public."staff_webauthn_credential" FROM taxtronik_app;',
    );
    expect(hardeningMigration).toContain('SET search_path = pg_catalog, pg_temp');
  });

  it('spiegelt die administrative Recovery-Hierarchie in der RLS-Entscheidung', () => {
    expect(recoveryHierarchyMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(recoveryHierarchyMigration).toContain(
      'CREATE OR REPLACE FUNCTION app.staff_webauthn_credential_access_allowed(',
    );
    expect(recoveryHierarchyMigration).toContain(
      'ADD COLUMN "attestation_verified_at" TIMESTAMP(3) NOT NULL',
    );
    expect(recoveryHierarchyMigration).toContain(
      'ADD COLUMN "attestation_format" VARCHAR(32) NOT NULL',
    );
    expect(recoveryHierarchyMigration).toContain(
      'credential."attestation_verified_at" IS NOT NULL',
    );
    expect(recoveryHierarchyMigration).toContain(
      'NEW."attestation_verified_at" IS DISTINCT FROM OLD."attestation_verified_at"',
    );
    expect(recoveryHierarchyMigration).toContain(
      'NEW."attestation_format" IS DISTINCT FROM OLD."attestation_format"',
    );
    expect(recoveryHierarchyMigration).toContain('actor_role."role" = \'ADMIN\'');
    expect(recoveryHierarchyMigration).toContain('target_role."role" = \'ADMIN\'');
    expect(recoveryHierarchyMigration).toContain('actor_role."role" = \'PARTNER\'');
    expect(recoveryHierarchyMigration).toContain("target_role.\"role\" IN ('ADMIN', 'PARTNER')");
    expect(recoveryHierarchyMigration).toContain('actor."id" = credential_staff_user_id');
    expect(recoveryHierarchyMigration).toContain('SECURITY DEFINER');
    expect(recoveryHierarchyMigration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(recoveryHierarchyMigration).toContain(
      'REVOKE ALL ON FUNCTION app.staff_webauthn_credential_access_allowed(UUID, UUID)',
    );
    expect(recoveryHierarchyMigration).toContain(
      'CREATE POLICY "staff_webauthn_credential_self_insert"',
    );
    expect(recoveryHierarchyMigration).toContain(
      'app.staff_webauthn_credential_insert_allowed("tenant_id", "staff_user_id")',
    );
    expect(recoveryHierarchyMigration).toContain(
      'CREATE OR REPLACE FUNCTION app.lock_staff_account_recovery(',
    );
    expect(recoveryHierarchyMigration).toContain('CREATE TRIGGER "staff_role_auth_state_lock"');
    expect(recoveryHierarchyMigration).toContain('BEFORE INSERT OR UPDATE OR DELETE');
  });

  it('kapselt fremde Widerrufe in einer serialisierten Recovery-Prozedur', () => {
    expect(recoveryProcedureMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(recoveryProcedureMigration).toContain(
      'DROP POLICY "staff_webauthn_credential_hierarchical_update"',
    );
    expect(recoveryProcedureMigration).toContain(
      'CREATE POLICY "staff_webauthn_credential_self_update"',
    );
    expect(recoveryProcedureMigration).toContain(
      'app.staff_webauthn_credential_insert_allowed("tenant_id", "staff_user_id")',
    );
    expect(recoveryProcedureMigration).toContain(
      'CREATE OR REPLACE FUNCTION app.revoke_staff_webauthn_credentials_for_recovery(',
    );
    expect(recoveryProcedureMigration).toContain('VOLATILE');
    expect(recoveryProcedureMigration).toContain('SECURITY DEFINER');
    expect(recoveryProcedureMigration).toContain(
      'BEFORE UPDATE OF "hardware_only_enabled_at", "active", "auth_revision"',
    );
    expect(recoveryProcedureMigration).toContain(
      'actor_staff_user_id::TEXT < target_staff_user_id::TEXT',
    );
    expect(recoveryProcedureMigration).toContain('pg_catalog.pg_advisory_xact_lock(');
    expect(recoveryProcedureMigration).toContain('actor."active" = TRUE');
    expect(recoveryProcedureMigration).toContain('NOT (actor_is_admin OR actor_is_partner)');
    expect(recoveryProcedureMigration).toContain('target_role."role" = \'ADMIN\'');
    expect(recoveryProcedureMigration).toContain('target_role."role" = \'PARTNER\'');
    expect(recoveryProcedureMigration).toContain(
      'UPDATE public."staff_webauthn_credential" credential',
    );
    expect(recoveryProcedureMigration).toContain(
      'REVOKE ALL ON FUNCTION app.revoke_staff_webauthn_credentials_for_recovery(UUID)',
    );
    expect(recoveryProcedureMigration).toContain(
      'GRANT EXECUTE ON FUNCTION app.revoke_staff_webauthn_credentials_for_recovery(UUID)',
    );
    expect(recoveryProcedureMigration).toContain('SET search_path = pg_catalog, pg_temp');
  });

  it('bindet die attestierte Authenticator-Version unveraenderlich an uint32', () => {
    expect(authenticatorVersionMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(authenticatorVersionMigration).toContain('ADD COLUMN "authenticator_version" BIGINT');
    expect(authenticatorVersionMigration).toContain(
      '"authenticator_version" BETWEEN 0 AND 4294967295',
    );
    expect(authenticatorVersionMigration).toContain(
      'COMMENT ON COLUMN public."staff_webauthn_credential"."authenticator_version"',
    );
    expect(authenticatorVersionMigration).toContain(
      'NEW."authenticator_version" IS DISTINCT FROM OLD."authenticator_version"',
    );
    expect(authenticatorVersionMigration).toContain(
      'CREATE OR REPLACE FUNCTION app.lock_staff_hardware_auth_state()',
    );
    expect(authenticatorVersionMigration).toContain(
      'REVOKE ALL ON FUNCTION app.lock_staff_hardware_auth_state() FROM PUBLIC',
    );
    expect(authenticatorVersionMigration).toContain('SET search_path = pg_catalog, pg_temp');
  });

  it('haelt den globalen MDS-Serienanker monoton und vollstaendig owner-only', () => {
    expect(mdsTrustStateMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(mdsTrustStateMigration).toContain('CREATE TABLE public."fido_mds_trust_state"');
    expect(mdsTrustStateMigration).toContain(
      'CONSTRAINT "fido_mds_trust_state_singleton_check" CHECK ("singleton")',
    );
    expect(mdsTrustStateMigration).toContain(
      'CONSTRAINT "fido_mds_trust_state_blob_serial_check" CHECK ("blob_serial" > 0)',
    );
    expect(mdsTrustStateMigration).toContain(
      'REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM PUBLIC',
    );
    expect(mdsTrustStateMigration).toContain(
      'REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM taxtronik_app',
    );
    expect(rlsVerifier).toContain("'fido_mds_trust_state'");
  });

  it('bindet WebAuthn-Commits per eng begrenztem Definer-Lock an den MDS-Stand', () => {
    expect(mdsCommitGuardMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(mdsCommitGuardMigration).toContain(
      'CREATE OR REPLACE FUNCTION app.lock_matching_fido_mds_serial(expected_serial BIGINT)',
    );
    expect(mdsCommitGuardMigration).toContain('SECURITY DEFINER');
    expect(mdsCommitGuardMigration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(mdsCommitGuardMigration).toContain('FOR SHARE OF trust_state');
    expect(mdsCommitGuardMigration).toContain(
      'REVOKE ALL ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) FROM PUBLIC',
    );
    expect(mdsCommitGuardMigration).toContain(
      'GRANT EXECUTE ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) TO taxtronik_app',
    );
  });

  it('bindet Rolling-Deployments atomar an Policy-Revision und Allowlist-Hash', () => {
    expect(mdsPolicyBindingMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(schema).toMatch(/policyRevision\s+BigInt\s+@map\("policy_revision"\)/);
    expect(schema).toMatch(/policyHash\s+String\s+@map\("policy_hash"\) @db\.VarChar\(64\)/);
    expect(mdsPolicyBindingMigration).toContain('CHECK ("policy_revision" >= 0)');
    expect(mdsPolicyBindingMigration).toContain('CHECK ("policy_hash" ~ \'^[0-9a-f]{64}$\')');
    expect(mdsPolicyBindingMigration).toContain('CHECK ("blob_serial" >= 0)');
    expect(mdsPolicyBindingMigration).toContain(
      'DROP FUNCTION app.lock_matching_fido_mds_serial(BIGINT)',
    );
    expect(mdsPolicyBindingMigration).toContain(
      'CREATE FUNCTION app.lock_matching_fido_mds_state(',
    );
    expect(mdsPolicyBindingMigration).toContain(
      'trust_state."policy_revision" = expected_policy_revision',
    );
    expect(mdsPolicyBindingMigration).toContain('trust_state."policy_hash" = expected_policy_hash');
    expect(mdsPolicyBindingMigration).toContain('FOR SHARE OF trust_state');
    const begin = mdsPolicyBindingMigration.indexOf('BEGIN;');
    const grant = mdsPolicyBindingMigration.indexOf(
      'GRANT EXECUTE ON FUNCTION app.lock_matching_fido_mds_state',
    );
    const commit = mdsPolicyBindingMigration.lastIndexOf('COMMIT;');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(grant);
    expect(grant).toBeLessThan(commit);
  });

  it('verhindert einen Staff-seitigen Demotions-Bypass der Recovery-Hierarchie', () => {
    expect(recoveryRoleFloorMigration).toContain('-- Fachkatalog: ACCESS-TENANT-RLS-001');
    expect(recoveryRoleFloorMigration).toContain(
      'CREATE FUNCTION app.enforce_staff_recovery_role_floor()',
    );
    expect(recoveryRoleFloorMigration).toContain('OLD."role"::TEXT = \'ADMIN\'');
    expect(recoveryRoleFloorMigration).toContain('OLD."role"::TEXT = \'PARTNER\'');
    expect(recoveryRoleFloorMigration).toContain('actor_role."role"::TEXT = \'ADMIN\'');
    expect(recoveryRoleFloorMigration).toContain(
      'BEFORE UPDATE OF "role", "staff_user_id" OR DELETE',
    );
    expect(recoveryRoleFloorMigration).toContain(
      'NEW."staff_user_id" IS NOT DISTINCT FROM OLD."staff_user_id"',
    );
    expect(recoveryRoleFloorMigration).toContain('SECURITY DEFINER');
    expect(recoveryRoleFloorMigration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(recoveryRoleFloorMigration).toContain(
      'REVOKE ALL ON FUNCTION app.enforce_staff_recovery_role_floor() FROM PUBLIC',
    );
  });

  it('widerruft eingeschleuste Hardware-Credentials auch bei Passwort-/TOTP-Reset', () => {
    expect(securityResetCredentialMigration).toContain(
      '-- Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001',
    );
    expect(securityResetCredentialMigration).toContain(
      'CREATE FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(',
    );
    expect(securityResetCredentialMigration).toContain('actor_staff_user_id::TEXT');
    expect(securityResetCredentialMigration).toContain(
      'actor."auth_revision" = expected_actor_auth_revision',
    );
    expect(securityResetCredentialMigration).toContain('pg_catalog.pg_advisory_xact_lock(');
    expect(securityResetCredentialMigration).toContain('target_is_admin');
    expect(securityResetCredentialMigration).toContain(
      'UPDATE public."staff_webauthn_credential" credential',
    );
    expect(securityResetCredentialMigration).toContain('SECURITY DEFINER');
    expect(securityResetCredentialMigration).toContain(
      'REVOKE ALL ON FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(UUID, INTEGER)',
    );
    expect(securityResetCredentialMigration).toContain(
      'GRANT EXECUTE ON FUNCTION app.revoke_staff_webauthn_credentials_for_security_reset(UUID, INTEGER)',
    );
  });
});
