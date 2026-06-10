// =============================================================================
// Einmalige Erzeugung des Ed25519-Schlüsselpaars für das Update-Manifest.
//
//   node scripts/release/generate-update-key.mjs
//
// Privater Schlüssel  → Forgejo-Repo-Secret UPDATE_MANIFEST_PRIVATE_KEY
//                       (signiert in release.yml das Manifest)
// Öffentlicher Schlüssel (raw 32 Byte, base64) → Kunden-.env UPDATE_PUBLIC_KEY
//                       (verifiziert in apps/web/src/server/update/manifest.ts)
//
// Der private Schlüssel wird NUR ausgegeben, nie geschrieben — bewusst, damit
// er nicht versehentlich im Arbeitsverzeichnis (und damit via gitleaks-Alarm
// oder schlimmer im Repo) landet.
// =============================================================================

import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
// SPKI-DER = 12 Byte fixer Ed25519-Header + 32 Byte raw key. Das raw-Format
// ist kompakt für die .env; manifest.ts akzeptiert beides (PEM oder raw-32).
const publicRawB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');

process.stdout.write(
  [
    '── Privater Schlüssel ───────────────────────────────────────────────',
    'Als Forgejo-Repo-Secret UPDATE_MANIFEST_PRIVATE_KEY hinterlegen',
    '(kompletter PEM-Block inkl. BEGIN/END-Zeilen):',
    '',
    privatePem.trim(),
    '',
    '── Öffentlicher Schlüssel ───────────────────────────────────────────',
    'In die Kunden-.env (und .env.example-Doku) als UPDATE_PUBLIC_KEY:',
    '',
    `UPDATE_PUBLIC_KEY=${publicRawB64}`,
    '',
    'WICHTIG: Den privaten Schlüssel sicher verwahren (Vault/Passwortmanager).',
    'Geht er verloren, müssen alle Installationen einen neuen Public Key',
    'erhalten, bevor sie wieder Updates sehen.',
    '',
  ].join('\n'),
);
