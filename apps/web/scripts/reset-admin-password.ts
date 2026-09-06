// Production Break-glass-Recovery. Fachkatalog: AUDIT-HASH-CHAIN-001,
// ACCESS-TENANT-RLS-001.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import { EvidenceService } from '@taxtronik/evidence/service';
import { LocalTimestampAdapter } from '@taxtronik/evidence/ports/timestamp';
import {
  AdminBreakGlassTargetError,
  resetAdminAccessForBreakGlass,
  writeAdminBreakGlassCredentials,
} from '../src/server/auth/admin-break-glass';

const prismaOwner = new PrismaClient({
  adapter: createPostgresAdapter(requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL')),
});

function fail(message: string): never {
  console.error(`[reset-admin-password] FATAL: ${message}`);
  process.exit(1);
}

function generatedPassword(): string {
  return randomBytes(18).toString('base64url');
}

function credentialsTarget(): string {
  const explicitPath = process.env['ADMIN_CREDENTIALS_PATH']?.trim();
  return resolve(
    explicitPath || process.env['INIT_CWD'] || process.cwd(),
    explicitPath ? '' : '.admin-credentials.txt',
  );
}

async function main(): Promise<void> {
  const adminEmail = process.env['ADMIN_EMAIL']?.trim().toLowerCase();
  const tenantSlug = process.env['TENANT_SLUG']?.trim().toLowerCase();
  const supplied = process.env['ADMIN_PASSWORD'];
  const explicitPassword = supplied?.trim() ? supplied : undefined;
  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    fail('ADMIN_EMAIL fehlt oder ist keine gueltige E-Mail-Adresse.');
  }
  if (!tenantSlug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantSlug)) {
    fail('TENANT_SLUG fehlt oder ist ungueltig (a-z, 0-9, Bindestrich).');
  }
  if (explicitPassword !== undefined && explicitPassword.length < 12) {
    fail('ADMIN_PASSWORD muss mindestens 12 Zeichen haben.');
  }

  const password = explicitPassword ?? generatedPassword();
  const credentialPath = credentialsTarget();
  const result = await resetAdminAccessForBreakGlass({
    prisma: prismaOwner,
    evidence: new EvidenceService(new LocalTimestampAdapter()),
    adminEmail,
    tenantSlug,
    passwordHash: await bcrypt.hash(password, 12),
    beforeCommit: ({ email }) => {
      writeAdminBreakGlassCredentials({ target: credentialPath, email, password });
    },
  });

  console.log(
    `[reset-admin-password] Passwort gesetzt: ${result.email} (Tenant: ${result.tenantSlug})`,
  );
  console.log('[reset-admin-password] TOTP wird beim naechsten Login neu eingerichtet.');
  console.log(
    `[reset-admin-password] Hardware-only deaktiviert; ${result.revokedHardwareKeys} Sicherheitsschluessel gesperrt.`,
  );
  console.log(
    `Admin-Zugangsdaten sicher und exklusiv gespeichert in: ${credentialPath} (POSIX: 0600).`,
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AdminBreakGlassTargetError) fail(message);
    console.error('[reset-admin-password] Fehler:', error);
    process.exitCode = 1;
  })
  .finally(() => prismaOwner.$disconnect());
