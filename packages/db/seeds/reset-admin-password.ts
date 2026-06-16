// =============================================================================
// Admin-Passwort-Recovery fuer Production.
//
// Setzt fuer ein bestehendes Admin-/Staff-Konto ein neues Passwort, aktiviert
// den Account wieder und startet das TOTP-Onboarding neu. Keine Tenant- oder
// Benutzeranlage; das Zielkonto muss existieren.
// =============================================================================

import { PrismaClient } from '../src/prisma-client';
import bcrypt from 'bcryptjs';
import { createPostgresAdapter, requireDatabaseUrl } from '../src/prisma-adapter';
import { generateAdminPassword, writeAdminCredentials } from './lib';

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL')),
});

function fail(msg: string): never {
  console.error(`[reset-admin-password] FATAL: ${msg}`);
  process.exit(1);
}

async function main() {
  const adminEmail = process.env['ADMIN_EMAIL']?.trim().toLowerCase();
  const slug = (process.env['TENANT_SLUG']?.trim() || 'default').toLowerCase();
  const explicitPasswordRaw = process.env['ADMIN_PASSWORD'];
  const explicitPassword = explicitPasswordRaw && explicitPasswordRaw.trim() ? explicitPasswordRaw : undefined;

  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    fail('ADMIN_EMAIL fehlt oder ist keine gueltige E-Mail-Adresse.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    fail(`TENANT_SLUG '${slug}' ist ungueltig (a-z, 0-9, Bindestrich).`);
  }
  if (explicitPassword !== undefined && explicitPassword.length < 12) {
    fail('ADMIN_PASSWORD muss mindestens 12 Zeichen haben.');
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) fail(`Tenant '${slug}' existiert nicht.`);

  const staff = await prisma.staffUser.findFirst({
    where: { tenantId: tenant.id, email: adminEmail },
    select: { id: true, email: true },
  });
  if (!staff) fail(`Staff-Konto '${adminEmail}' im Tenant '${slug}' existiert nicht.`);

  const adminPassword = explicitPassword ?? generateAdminPassword();
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await prisma.staffUser.update({
    where: { id: staff.id },
    data: {
      passwordHash,
      active: true,
      lockedUntil: null,
      failedLoginCount: 0,
      totpSecretEnc: null,
      totpEnrolledAt: null,
      totpSetupStartedAt: null,
      totpBackupCodes: null,
    },
  });

  console.log(`[reset-admin-password] Passwort gesetzt: ${staff.email} (Tenant: ${slug})`);
  console.log('[reset-admin-password] TOTP wird beim naechsten Login neu eingerichtet.');

  const credPath = writeAdminCredentials(staff.email, adminPassword);
  if (!explicitPassword) {
    console.log('');
    console.log('  ============================================================');
    console.log('  Neues Admin-Passwort (NUR diesmal sichtbar):');
    console.log(`    ${adminPassword}`);
    console.log(`  Auch gespeichert in: ${credPath} (chmod 600)`);
    console.log('  Nach dem Login + TOTP-Setup die Datei sicher loeschen.');
    console.log('  ============================================================');
    console.log('');
  } else {
    console.log(`  Admin-Passwort aus $ADMIN_PASSWORD uebernommen und gespeichert in: ${credPath} (chmod 600).`);
  }
}

main()
  .catch((e) => {
    console.error('[reset-admin-password] Fehler:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
