// =============================================================================
// Production-Provisionierung — legt GENAU die Grundausstattung einer neuen
// Installation an: Tenant, Default-Dokumenttypen, ein Admin-Konto.
// KEINE Demodaten (kein Testmandant, kein Portal-Kontakt, keine Anforderung).
// Läuft bewusst auch — und gerade — mit NODE_ENV=production.
//
// Aufruf (auf dem Server, nach Migrationen):
//   TENANT_NAME="Kanzlei Müller" ADMIN_EMAIL="admin@kanzlei-mueller.de" \
//     pnpm --filter @taxtronik/db provision
//
// Optional:
//   TENANT_SLUG     (Default: 'default' — Login-Feld „Kanzlei")
//   ADMIN_PASSWORD  (min. 12 Zeichen; sonst zufällig generiert, einmalig
//                    angezeigt + in .admin-credentials.txt, chmod 600)
//
// Schutz: Hat der Tenant bereits Mitarbeiter, bricht das Skript ab — eine
// laufende Installation wird nie still verändert (kein Passwort-Reset, keine
// Zweit-Admins durch erneutes Ausführen). Benutzerpflege danach in der App.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPostgresAdapter, requireDatabaseUrl } from '../src/prisma-adapter';
import { ensureDefaultDocumentTypes, generateAdminPassword } from './lib';

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL')),
});

function fail(msg: string): never {
  console.error(`[provision] FATAL: ${msg}`);
  process.exit(1);
}

async function main() {
  const tenantName = process.env['TENANT_NAME']?.trim();
  const adminEmail = process.env['ADMIN_EMAIL']?.trim().toLowerCase();
  const slug = (process.env['TENANT_SLUG']?.trim() || 'default').toLowerCase();
  const explicitPassword = process.env['ADMIN_PASSWORD'];

  if (!tenantName) fail('TENANT_NAME fehlt (Anzeigename der Kanzlei).');
  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    fail('ADMIN_EMAIL fehlt oder ist keine gültige E-Mail-Adresse.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    fail(`TENANT_SLUG '${slug}' ist ungültig (a-z, 0-9, Bindestrich).`);
  }
  if (explicitPassword !== undefined && explicitPassword.length < 12) {
    fail('ADMIN_PASSWORD muss mindestens 12 Zeichen haben.');
  }

  console.log(`[provision] Tenant '${tenantName}' (slug: ${slug}) …`);

  let tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (tenant) {
    const staffCount = await prisma.staffUser.count({ where: { tenantId: tenant.id } });
    if (staffCount > 0) {
      fail(
        `Tenant '${slug}' existiert bereits mit ${staffCount} Mitarbeiter-Konto/Konten — ` +
          'Installation ist schon provisioniert. Benutzer bitte in der App verwalten ' +
          '(Administration → Benutzer).',
      );
    }
    console.log('[provision] Tenant existiert (ohne Mitarbeiter) — wird weiterverwendet.');
  } else {
    tenant = await prisma.tenant.create({ data: { slug, name: tenantName } });
    console.log(`[provision] Tenant angelegt: ${tenant.id}`);
  }

  await ensureDefaultDocumentTypes(prisma, tenant.id);

  const adminPassword = explicitPassword ?? generateAdminPassword();
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.staffUser.create({
    data: {
      tenantId: tenant.id,
      email: adminEmail,
      fullName: 'Administrator',
      passwordHash,
      active: true,
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });
  console.log(`[provision] Admin-Konto angelegt: ${admin.email}`);

  if (!explicitPassword) {
    const credPath = resolve(process.cwd(), '.admin-credentials.txt');
    writeFileSync(credPath, `email=${adminEmail}\npassword=${adminPassword}\n`, { mode: 0o600 });
    console.log('');
    console.log('  ============================================================');
    console.log('  Initiales Admin-Passwort (NUR diesmal sichtbar):');
    console.log(`    ${adminPassword}`);
    console.log(`  Auch gespeichert in: ${credPath} (chmod 600)`);
    console.log('  Nach dem ersten Login + TOTP-Setup die Datei sicher löschen.');
    console.log('  ============================================================');
    console.log('');
  }

  console.log('[provision] Fertig — keine Demodaten angelegt.');
  console.log(`  Login: ${adminEmail} (Kanzlei-Feld: '${slug}')`);
  console.log('  TOTP wird beim ersten Login eingerichtet (Pflicht).');
}

main()
  .catch((e) => {
    console.error('[provision] Fehler:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
