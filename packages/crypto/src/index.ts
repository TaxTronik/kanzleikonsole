// =============================================================================
// @taxtronik/crypto — symmetrische Secret-Verschlüsselung
//
// Anwendungsfälle: SMTP-Passwörter, n8n-HMAC-Secret, n8n-API-Key — alles,
// was in `tenant_setting` JSONB landet und nicht im Klartext in DB-Backups
// auftauchen darf.
//
// Verfahren: AES-256-GCM mit Schlüssel aus AUTH_SECRET. IV (12 B) zufällig
// pro Verschlüsselung. Format: `v<n>:<iv-b64>:<auth-tag-b64>:<ciphertext-b64>`.
//
// Versions-Historie:
//   v1: deriveKey = SHA-256(AUTH_SECRET) — keine Domain-Trennung. Wenn
//       AUTH_SECRET an anderer Stelle (Auth.js-JWT-Signing) leakt, war damit
//       auch der secret-box-Key kompromittiert.
//   v2: deriveKey = HKDF-SHA256(AUTH_SECRET, salt, info='taxtronik-secret-box-v2')
//       — Domain-getrennt, sodass kein anderer AUTH_SECRET-Konsument denselben
//       Key materialisiert. Spiegelt das Pattern aus auth/totp.ts.
//
// M-7: Web und Worker nutzten vorher zwei separate Kopien dieser Datei. Jetzt
// eine Quelle für beide.
//
// M-1: HKDF mit Context-Label statt nacktem SHA-256. Decrypt kann beide
// Versionen lesen — neue Werte werden v2 geschrieben.
// =============================================================================

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '@taxtronik/config';

const CURRENT_VERSION = 'v2';
const IV_LEN = 12; // GCM standard
const ALGO = 'aes-256-gcm';

// HKDF-Salt für v2. Konstanter, gepinneter Wert — Salt soll laut RFC 5869
// nicht-geheim sein können, dient nur der domain-Trennung gegen Schlüssel-
// Reuse über andere HKDF-Aufrufer (z. B. auth/totp.ts).
const HKDF_SALT = Buffer.from('taxtronik-secret-box-v2-salt', 'utf8');
const HKDF_INFO = Buffer.from('taxtronik-secret-box-v2', 'utf8');

function deriveKeyV1(): Buffer {
  return createHash('sha256').update(env.AUTH_SECRET).digest();
}

function deriveKeyV2(): Buffer {
  // hkdfSync(digest, ikm, salt, info, keylen) → ArrayBuffer
  const ab = hkdfSync('sha256', env.AUTH_SECRET, HKDF_SALT, HKDF_INFO, 32);
  return Buffer.from(ab);
}

function deriveKeyFor(version: string): Buffer {
  if (version === 'v2') return deriveKeyV2();
  if (version === 'v1') return deriveKeyV1();
  throw new Error(`Unbekannte Secret-Blob-Version: ${version}`);
}

/**
 * Verschlüsselt einen Plaintext. Leerer String → leerer String.
 * Schreibt immer im aktuellen Format (v2 mit HKDF-Key).
 */
export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const key = deriveKeyFor(CURRENT_VERSION);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CURRENT_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Entschlüsselt einen Wert von `encryptSecret`. Akzeptiert sowohl v1 (alter
 * SHA-256-Key, für Bestandsdaten) als auch v2 (HKDF). Wirft bei Manipulation
 * oder unbekannter Version. Leerer Input → leerer Output.
 *
 * Migrations-Hinweis: alte v1-Secrets bleiben dechiffrierbar. Beim nächsten
 * Save-Pfad (Settings-Update) werden sie automatisch in v2 re-encrypted —
 * keine separate Rotations-Migration nötig.
 */
export function decryptSecret(blob: string): string {
  if (!blob) return '';
  const parts = blob.split(':');
  if (parts.length !== 4) {
    throw new Error('Ungültiger Secret-Blob.');
  }
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = deriveKeyFor(version);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * True, wenn der Wert wie ein gültiger Secret-Blob aussieht (zur sicheren
 * Migration von Klartext → verschlüsselt).
 *
 * M-4: ACHTUNG — reine Strukturheuristik (Prefix `v1:`/`v2:` + 4 Doppelpunkt-
 * Felder). Kein Crypto-Check. Wenn jemand bewusst `v2:a:b:c` als Klartext
 * einträgt, würde looksEncrypted ein falsches `true` liefern. Akzeptabel als
 * Migrations-Gate (Klartext → encrypted erkennen), NICHT als Sicherheits-
 * Entscheidung. Vor schreibendem Pfad immer separat versuchen
 * `decryptSecret(value)` — schlägt das mit Manipulation fehl, ist's kein
 * echter Blob.
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(':');
  if (parts.length !== 4) return false;
  return parts[0] === 'v1' || parts[0] === 'v2';
}
