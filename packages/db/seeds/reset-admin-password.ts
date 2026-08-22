// =============================================================================
// Admin-Passwort-Recovery fuer Production.
//
// Setzt fuer ein bestehendes Admin-/Staff-Konto ein neues Passwort, aktiviert
// den Account wieder und startet das TOTP-Onboarding neu. ADMIN_EMAIL und
// TENANT_SLUG sind Pflicht, damit auch bei mehreren Tenants/Admins niemals ein
// implizit gewähltes Konto verändert wird. Keine Tenant- oder Benutzeranlage;
// das Zielkonto muss existieren.
// =============================================================================

import { Prisma, PrismaClient } from '../src/prisma-client';
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
  const slug = process.env['TENANT_SLUG']?.trim().toLowerCase();
  const explicitPasswordRaw = process.env['ADMIN_PASSWORD'];
  const explicitPassword =
    explicitPasswordRaw && explicitPasswordRaw.trim() ? explicitPasswordRaw : undefined;

  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    fail('ADMIN_EMAIL fehlt oder ist keine gueltige E-Mail-Adresse.');
  }
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    fail('TENANT_SLUG fehlt oder ist ungueltig (a-z, 0-9, Bindestrich).');
  }
  if (explicitPassword !== undefined && explicitPassword.length < 12) {
    fail('ADMIN_PASSWORD muss mindestens 12 Zeichen haben.');
  }

  const candidates = await prisma.staffUser.findMany({
    where: {
      email: adminEmail,
      tenant: { slug },
      roles: { some: { role: 'ADMIN' } },
    },
    select: {
      id: true,
      email: true,
      tenant: { select: { slug: true, name: true } },
    },
    orderBy: [{ tenant: { slug: 'asc' } }, { email: 'asc' }],
  });

  if (candidates.length === 0) {
    fail('Kein passendes ADMIN-Konto gefunden. Es wurde nichts verändert.');
  }
  if (candidates.length > 1) {
    console.error(
      '[reset-admin-password] Mehrere ADMIN-Konten gefunden. Bitte mit ADMIN_EMAIL oder TENANT_SLUG eindeutig machen:',
    );
    for (const c of candidates) {
      console.error(`  TENANT_SLUG=${c.tenant.slug} ADMIN_EMAIL=${c.email} (${c.tenant.name})`);
    }
    process.exit(1);
  }

  const staff = candidates[0];
  if (!staff) fail('Kein ADMIN-Konto gefunden.');

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
      totpBackupCodes: Prisma.DbNull,
    },
  });

  console.log(
    `[reset-admin-password] Passwort gesetzt: ${staff.email} (Tenant: ${staff.tenant.slug})`,
  );
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
    console.log(
      `  Admin-Passwort aus $ADMIN_PASSWORD uebernommen und gespeichert in: ${credPath} (chmod 600).`,
    );
  }
}

main()
  .catch((e) => {
    console.error('[reset-admin-password] Fehler:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
