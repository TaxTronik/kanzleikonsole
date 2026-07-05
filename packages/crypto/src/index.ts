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
//   v2: deriveKey = HKDF-SHA256(IKM, salt, info='taxtronik-secret-box-v2')
//       — Domain-getrennt, sodass kein anderer AUTH_SECRET-Konsument denselben
//       Key materialisiert. Spiegelt das Pattern aus auth/totp.ts.
//
// M-7: Web und Worker nutzten vorher zwei separate Kopien dieser Datei. Jetzt
// eine Quelle für beide.
//
// M-1: HKDF mit Context-Label statt nacktem SHA-256. Decrypt kann beide
// Versionen lesen — neue Werte werden v2 geschrieben.
//
// N-2 (Key-Ableitung/Rotation): IKM für die HKDF-Ableitung ist per Default
// AUTH_SECRET. Da AUTH_SECRET auch das Auth.js-JWT-Signing trägt, würde eine
// AUTH_SECRET-Rotation ALLE gespeicherten Secrets undechiffrierbar machen.
// Abhilfe (rückwärtskompatibel): das OPTIONALE env.SECRET_BOX_KEY. Ist es
// gesetzt, dient es als HKDF-IKM statt AUTH_SECRET → der Box-Key entkoppelt
// sich von AUTH_SECRET und übersteht dessen Rotation. Ist es NICHT gesetzt,
// bleibt das bisherige Verhalten exakt erhalten (Fallback AUTH_SECRET), sodass
// Bestands-Blobs weiter entschlüsselt werden. ACHTUNG: Das Drahtformat kennt
// keine Key-ID/Key-Ring — eine ECHTE Rotation des Box-Keys erfordert weiterhin
// einen Re-Wrap der Bestands-Secrets (entschlüsseln mit altem, neu
// verschlüsseln mit neuem Key). SECRET_BOX_KEY löst nur die AUTH_SECRET-
// Kopplung, nicht die Rotation des Box-Keys selbst.
// =============================================================================

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '@taxtronik/config';

const CURRENT_VERSION = 'v2';
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM Auth-Tag: volle 128 Bit — kürzere Tags werden abgelehnt (N-1)
const ALGO = 'aes-256-gcm';

/**
 * IKM für die HKDF-Ableitung (N-2). Bevorzugt das dedizierte, optionale
 * SECRET_BOX_KEY; ohne dieses Fallback auf AUTH_SECRET (bisheriges Verhalten,
 * damit Bestands-Blobs weiter lesbar bleiben).
 */
function secretBoxIkm(): string {
  return env.SECRET_BOX_KEY ?? env.AUTH_SECRET;
}

// HKDF-Salt für v2. Konstanter, gepinneter Wert — Salt soll laut RFC 5869
// nicht-geheim sein können, dient nur der domain-Trennung gegen Schlüssel-
// Reuse über andere HKDF-Aufrufer (z. B. auth/totp.ts).
const HKDF_SALT = Buffer.from('taxtronik-secret-box-v2-salt', 'utf8');
const HKDF_INFO = Buffer.from('taxtronik-secret-box-v2', 'utf8');

function deriveKeyV1(): Buffer {
  // v1-Bestandsdaten wurden IMMER aus AUTH_SECRET abgeleitet — nicht auf
  // SECRET_BOX_KEY umstellen, sonst werden alte v1-Blobs undechiffrierbar.
  return createHash('sha256').update(env.AUTH_SECRET).digest();
}

function deriveKeyV2(): Buffer {
  // hkdfSync(digest, ikm, salt, info, keylen) → ArrayBuffer
  // IKM: SECRET_BOX_KEY falls gesetzt, sonst AUTH_SECRET (N-2).
  const ab = hkdfSync('sha256', secretBoxIkm(), HKDF_SALT, HKDF_INFO, 32);
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
  // N-1: Länge von IV und Auth-Tag hart validieren, BEVOR sie an OpenSSL
  // gehen. Node akzeptiert bei AES-256-GCM sonst verkürzte Auth-Tags (ab
  // 4 Byte) via setAuthTag — das senkt die Forgery-Hürde drastisch. Wir
  // verlangen exakt das Format, das encryptSecret schreibt: IV 12 B, Tag 16 B.
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Ungültiges Krypto-Blob-Format: IV/Tag-Länge');
  }
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
