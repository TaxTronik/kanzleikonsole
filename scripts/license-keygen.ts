#!/usr/bin/env tsx
// =============================================================================
// scripts/license-keygen.ts — Lizenz-Keypair + Beispiel-Token generieren
//
// Aufruf:
//   pnpm tsx scripts/license-keygen.ts \
//     --kanzlei "Steuerkanzlei Müller GmbH" \
//     --slug muller \
//     --plan STANDARD \
//     --days 365 \
//     [--max-staff 50] [--max-clients 500]
//
// Ausgabe:
//   - LICENSE_PUBLIC_KEY (PEM, in die App-Env eintragen)
//   - LICENSE_PRIVATE_KEY (NICHT in die App-Env! Nur fürs Lizenz-Server)
//   - LICENSE_KEY (das JWT, in die Kunden-Env eintragen)
//
// Für produktiven Einsatz: Private-Key sicher verwahren (HSM o. ä.) und
// einen kleinen Lizenz-Server bauen, der pro Kunde signiert.
// =============================================================================

import { generateKeyPair, exportSPKI, exportPKCS8, SignJWT } from 'jose';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Args {
  kanzlei: string;
  slug: string;
  plan: string;
  days: number;
  maxStaff?: number;
  maxClients?: number;
}

function parseArgs(): Args {
  const m: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k && k.startsWith('--') && v && !v.startsWith('--')) {
      m[k.slice(2)] = v;
      i++;
    }
  }
  return {
    kanzlei: m['kanzlei'] ?? 'Beispielkanzlei',
    slug: m['slug'] ?? 'default',
    plan: m['plan'] ?? 'STANDARD',
    days: Number(m['days'] ?? '365'),
    maxStaff: m['max-staff'] ? Number(m['max-staff']) : undefined,
    maxClients: m['max-clients'] ? Number(m['max-clients']) : undefined,
  };
}

async function main() {
  const args = parseArgs();
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const publicPem = await exportSPKI(publicKey);
  const privatePem = await exportPKCS8(privateKey);

  const claims: Record<string, unknown> = {
    kanzleiName: args.kanzlei,
    plan: args.plan,
  };
  if (args.maxStaff !== undefined) claims['maxStaff'] = args.maxStaff;
  if (args.maxClients !== undefined) claims['maxClients'] = args.maxClients;

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setSubject(args.slug)
    .setExpirationTime(`${args.days}d`)
    .sign(privateKey);

  process.stdout.write('# Lizenz-Public-Key (in die Kunden-Env eintragen):\n');
  process.stdout.write('LICENSE_PUBLIC_KEY="');
  process.stdout.write(publicPem.replace(/\n/g, '\\n'));
  process.stdout.write('"\n\n');

  // S-4: Private-Key NIE auf stdout. Shell-History, Screencasts, CI-Logs und
  // Tee-Pattern landen den Wert sonst an Stellen, die für den Signing-Key
  // der gesamten Lizenz-Authority unangemessen sind. In Datei mit 0o600
  // schreiben, nur Pfad ausgeben.
  const privPath = resolve(process.cwd(), `licensing-private-${args.slug}.pem`);
  writeFileSync(privPath, privatePem, { mode: 0o600 });
  process.stdout.write(`# Lizenz-Private-Key geschrieben nach: ${privPath}\n`);
  process.stdout.write(`#   chmod 600 (only-owner-read). NICHT in Git, NICHT verteilen.\n`);
  process.stdout.write(`#   Empfehlung: in HSM/Vault verschieben und Datei sicher löschen (shred).\n\n`);

  process.stdout.write('# Lizenz-Token für den Kunden (LICENSE_KEY in der Kunden-Env):\n');
  process.stdout.write(`LICENSE_KEY="${token}"\n`);
}

main().catch((err) => {
  process.stderr.write(`Fehler: ${(err as Error).message}\n`);
  process.exit(1);
});
