// =============================================================================
// Dev-Seed — legt Testdaten für die lokale Entwicklung an.
//
// Ausführen: pnpm db:seed
//
// Erzeugt:
//   - Tenant "default" (slug: 'default')
//   - Admin-Mitarbeiter admin@taxtronik.local
//     - Passwort: standardmäßig zufällig generiert und auf stdout gezeigt
//     - mit ADMIN_PASSWORD=<wert> kann das alte „dev-password-123" für lokale
//       Wegwerf-Umgebungen wieder forciert werden
//     (TOTP-Setup beim ersten Login — kein Secret vorab gesetzt)
//   - Testmandant "Mustermann GmbH"
//
// U-3: Refuse in production. Vorher konnte das setup.sh-Default den Seed in
// einer produktiven On-Prem-Installation einspielen und einen Admin mit dem
// dokumentierten Schwachpasswort „dev-password-123" hinterlassen.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env['NODE_ENV'] === 'production') {
  console.error('[seed] FATAL: Dev-Seed darf NICHT in Produktion laufen.');
  console.error('[seed] NODE_ENV=production erkannt — Abbruch.');
  console.error('[seed] Für Production-Provisioning bitte ein dediziertes Skript verwenden,');
  console.error('[seed] das einen zufälligen Admin und ein zufälliges Passwort vorsieht.');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasourceUrl: process.env['DATABASE_URL'],
});

function generateAdminPassword(): string {
  // base64url, 18 Bytes = 24 Zeichen, ~144 Bit Entropie. Memorierbar genug
  // für einmaligen Login + TOTP-Setup, danach kann der Admin selbst rotieren.
  return randomBytes(18)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function main() {
  console.log('[seed] Starte Dev-Seed…');

  // 1. Tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'default' },
    update: { name: 'Musterkanzlei GmbH' },
    create: {
      slug: 'default',
      name: 'Musterkanzlei GmbH',
    },
  });
  console.log(`[seed] Tenant: ${tenant.name} (${tenant.id})`);

  // 2. Admin-Mitarbeiter — Passwort entweder aus ENV oder frisch generiert.
  // Kein hartcodiertes Default mehr (U-3). Wir schreiben das frisch erzeugte
  // Passwort zusätzlich in `.admin-credentials.txt` (chmod 600, gitignored)
  // damit es nicht ausschließlich im Terminal-Output landet.
  const explicitPassword = process.env['ADMIN_PASSWORD'];
  const adminPassword = explicitPassword && explicitPassword.length >= 8
    ? explicitPassword
    : generateAdminPassword();
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const existingAdmin = await prisma.staffUser.findFirst({
    where: { tenantId: tenant.id, email: 'admin@taxtronik.local' },
  });

  let admin;
  if (existingAdmin) {
    admin = await prisma.staffUser.update({
      where: { id: existingAdmin.id },
      data: { passwordHash, active: true, totpSecretEnc: null, totpEnrolledAt: null, totpSetupStartedAt: null },
    });
    console.log(`[seed] Admin-User aktualisiert: ${admin.email}`);
  } else {
    admin = await prisma.staffUser.create({
      data: {
        tenantId: tenant.id,
        email: 'admin@taxtronik.local',
        fullName: 'Admin Mustermann',
        passwordHash,
        active: true,
      },
    });
    console.log(`[seed] Admin-User angelegt: ${admin.email}`);
  }

  if (!explicitPassword) {
    const credPath = resolve(process.cwd(), '.admin-credentials.txt');
    writeFileSync(
      credPath,
      `email=admin@taxtronik.local\npassword=${adminPassword}\n`,
      { mode: 0o600 },
    );
    console.log('');
    console.log('  ============================================================');
    console.log('  Initiales Admin-Passwort (NUR diesmal sichtbar):');
    console.log(`    ${adminPassword}`);
    console.log(`  Auch gespeichert in: ${credPath} (chmod 600)`);
    console.log('  Nach dem ersten Login + TOTP-Setup die Datei sicher löschen.');
    console.log('  ============================================================');
    console.log('');
  } else {
    console.log('  Admin-Passwort aus $ADMIN_PASSWORD übernommen.');
  }

  // ADMIN-Rolle
  await prisma.staffRole.upsert({
    where: { staffUserId_role: { staffUserId: admin.id, role: 'ADMIN' } },
    update: {},
    create: { staffUserId: admin.id, role: 'ADMIN' },
  });

  // 3. Testmandant (allow_active=true für Entwicklung, damit Dokumente hochladbar)
  const client = await prisma.client.upsert({
    where: {
      tenantId_datevNo: { tenantId: tenant.id, datevNo: '10001' },
    },
    update: { name: 'Mustermann GmbH', allowActive: true },
    create: {
      tenantId: tenant.id,
      kind: 'JURPERS',
      name: 'Mustermann GmbH',
      datevNo: '10001',
      allowActive: true,
    },
  });
  console.log(`[seed] Testmandant: ${client.name} (${client.id})`);

  // 3b. Admin als Hauptbearbeiter zuordnen — damit „Meine Mandanten"-Filter
  // in Mandantenliste/Anforderungen/Steuerterminen sofort Treffer hat.
  await prisma.clientResponsibility.upsert({
    where: {
      clientId_staffId_role: {
        clientId: client.id,
        staffId: admin.id,
        role: 'HAUPTBEARBEITER',
      },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      clientId: client.id,
      staffId: admin.id,
      role: 'HAUPTBEARBEITER',
    },
  });
  console.log(`[seed] Bearbeiter-Zuordnung: admin → ${client.name}`);

  // 4. Beispiel-Portal-Kontakt (für Magic-Link-Test)
  const contact = await prisma.clientContact.upsert({
    where: {
      tenantId_email: { tenantId: tenant.id, email: 'mandant@taxtronik.local' },
    },
    update: { fullName: 'Max Mustermann', active: true, clientId: client.id },
    create: {
      tenantId: tenant.id,
      clientId: client.id,
      email: 'mandant@taxtronik.local',
      fullName: 'Max Mustermann',
      active: true,
    },
  });
  console.log(`[seed] Portal-Kontakt: ${contact.email}`);

  // 5. Beispiel-Anforderung
  const existingRequest = await prisma.request.findFirst({
    where: { tenantId: tenant.id, clientId: client.id, title: 'Belege Q3 2025' },
  });
  if (!existingRequest) {
    const req = await prisma.request.create({
      data: {
        tenantId: tenant.id,
        clientId: client.id,
        title: 'Belege Q3 2025',
        description:
          'Bitte laden Sie alle Eingangs- und Ausgangsrechnungen für das dritte Quartal 2025 hoch (Juli, August, September).',
        priority: 'NORMAL',
        status: 'OPEN',
        createdByStaff: admin.id,
        dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`[seed] Anforderung: ${req.title}`);
  }

  console.log('\n[seed] Fertig.');
  console.log('  Mitarbeiter-Login: admin@taxtronik.local / dev-password-123');
  console.log('  Portal-Login (Magic-Link): mandant@taxtronik.local');
  console.log('  → Magic-Link-Mail landet in MailHog (http://localhost:8025).');
}

main()
  .catch((e) => {
    console.error('[seed] Fehler:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
