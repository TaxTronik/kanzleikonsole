// =============================================================================
// @taxtronik/crypto — symmetrische Secret-Verschlüsselung
//
// Anwendungsfälle: SMTP-Passwörter, n8n-HMAC-Secret, n8n-API-Key, IBM-Token,
// Postfach-Zugangsdaten — alles, was in `tenant_setting` JSONB oder einer
// Secret-Spalte landet und nicht im Klartext in DB-Backups auftauchen darf.
// Die vollständige Liste der Ablageorte steht in `secret-slots.ts`.
//
// Verfahren: AES-256-GCM, IV (12 B) zufällig pro Verschlüsselung.
//
// Versions-Historie:
//   v1: `v1:<iv>:<tag>:<ct>`, deriveKey = SHA-256(AUTH_SECRET) — keine
//       Domain-Trennung. Nur noch lesbar.
//   v2: `v2:<iv>:<tag>:<ct>`, deriveKey = HKDF-SHA256(IKM, salt,
//       info='taxtronik-secret-box-v2') — Domain-getrennt (M-1). Nur noch
//       lesbar.
//   v3: `v3:<key-id>:<iv>:<tag>:<ct>` (S-08). Schlüssel aus einem
//       Schlüsselbund; die Key-ID benennt den Schlüssel, ohne etwas über ihn
//       zu verraten (eigener HKDF-Wert, 8 Byte hex). Als gebundene
//       Zusatzdaten (AAD) wird `taxtronik-secret-box-v3|<key-id>|<tenantId>|
//       <scope>|<field>` authentifiziert: Ein in der Datenbank in einen
//       anderen Tenant, eine andere Zeile, ein anderes Setting oder Feld
//       kopierter Wert lässt sich nicht entschlüsseln.
//
// Schlüssel (S-08, siehe docs/operations/secret-rotation.md):
//   - Wurzel: SECRET_BOX_KEY, ohne ihn AUTH_SECRET (N-2). Die Wurzel bleibt
//     bei einer Rotation der Datenschlüssel unverändert. Aus ihr leiten sich
//     der v2-Schlüssel und die Prüfsumme der Audit-Prüf-Checkpoints ab
//     (AUDIT-VERIFY-ALERT-001); sie entschlüsselt immer mit.
//   - Schlüsselbund: SECRET_BOX_KEYRING (optional, kommagetrennt). Der ERSTE
//     Eintrag verschlüsselt neue Werte; alle Einträge und die Wurzel
//     entschlüsseln. Ohne Schlüsselbund verschlüsselt die Wurzel.
//   - v1/v2 tragen keine Key-ID: Sie werden mit ihrem bisherigen Schlüssel
//     und hilfsweise mit jedem Schlüsselbund-Eintrag versucht (GCM-Tag
//     entscheidet).
//   - Rotation ohne Ausfallzeit: neuen Schlüssel zuerst als weiteren Eintrag
//     verteilen, dann an die erste Stelle setzen, danach
//     `pnpm secret-box:rewrap`, zuletzt den alten Eintrag entfernen.
//
// M-7: Web und Worker nutzten vorher zwei separate Kopien dieser Datei. Jetzt
// eine Quelle für beide.
// =============================================================================

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '@taxtronik/config';
import { canonicalSecretContext, type SecretContext } from './secret-slots';

export * from './secret-slots';

const CURRENT_VERSION = 'v3';
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM Auth-Tag: volle 128 Bit — kürzere Tags werden abgelehnt (N-1)
const ALGO = 'aes-256-gcm';
const KEY_ID_BYTES = 8;
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Wurzel-IKM (N-2). Bevorzugt das dedizierte, optionale SECRET_BOX_KEY; ohne
 * dieses Fallback auf AUTH_SECRET (bisheriges Verhalten, damit Bestands-Blobs
 * weiter lesbar bleiben).
 */
function secretBoxIkm(): string {
  return env.SECRET_BOX_KEY ?? env.AUTH_SECRET;
}

/** Einträge aus SECRET_BOX_KEYRING in konfigurierter Reihenfolge (erster = aktiv). */
function keyringIkms(): readonly string[] {
  return env.SECRET_BOX_KEYRING ?? [];
}

// HKDF-Salt für v2. Konstanter, gepinneter Wert — Salt soll laut RFC 5869
// nicht-geheim sein können, dient nur der domain-Trennung gegen Schlüssel-
// Reuse über andere HKDF-Aufrufer (z. B. auth/totp.ts).
const HKDF_SALT = Buffer.from('taxtronik-secret-box-v2-salt', 'utf8');
const HKDF_INFO = Buffer.from('taxtronik-secret-box-v2', 'utf8');
// v3: eigener Salt; Schlüssel und Key-ID sind getrennte HKDF-Ausgaben.
const V3_SALT = Buffer.from('taxtronik-secret-box-v3-salt', 'utf8');
const V3_KEY_INFO = Buffer.from('taxtronik-secret-box-v3', 'utf8');
const V3_KEY_ID_INFO = Buffer.from('taxtronik-secret-box-v3-key-id', 'utf8');
const V3_AAD_LABEL = 'taxtronik-secret-box-v3';

function deriveKeyV1(ikm: string): Buffer {
  // v1-Bestandsdaten wurden IMMER aus AUTH_SECRET abgeleitet.
  return createHash('sha256').update(ikm).digest();
}

function deriveKeyV2(ikm: string): Buffer {
  // hkdfSync(digest, ikm, salt, info, keylen) → ArrayBuffer
  return Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, 32));
}

function deriveKeyV3(ikm: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, V3_SALT, V3_KEY_INFO, 32));
}

function deriveKeyIdV3(ikm: string): string {
  return Buffer.from(hkdfSync('sha256', ikm, V3_SALT, V3_KEY_ID_INFO, KEY_ID_BYTES)).toString(
    'hex',
  );
}

// AUDIT-VERIFY-ALERT-001: Schlüssel für die HMAC-Prüfsumme der Prüf-Checkpoints
// der Audit-Kettenprüfung. Dasselbe IKM wie die Secret-Box-Wurzel, aber ein
// eigenes Info-Label → unabhängiger Schlüssel (RFC 5869); kein neues
// Pflicht-Secret.
const AUDIT_CHECKPOINT_MAC_INFO = Buffer.from('taxtronik-audit-verify-checkpoint-mac-v1', 'utf8');

/**
 * 32-Byte-Schlüssel für die HMAC-Prüfsumme der Prüf-Checkpoints
 * (`audit_verify_checkpoint.mac`). Er hängt ausschließlich an der Wurzel
 * (SECRET_BOX_KEY bzw. ohne ihn AUTH_SECRET), nicht am Schlüsselbund: Eine
 * Rotation der Datenschlüssel über SECRET_BOX_KEYRING lässt ihn unverändert.
 * Wechselt die Wurzel selbst, werden bestehende Checkpoints einmalig als nicht
 * authentisch gemeldet und die Kette ab Genesis neu geprüft.
 */
export function deriveAuditCheckpointMacKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', secretBoxIkm(), HKDF_SALT, AUDIT_CHECKPOINT_MAC_INFO, 32));
}

interface KeyringEntry {
  keyId: string;
  ikm: string;
}

/**
 * Schlüsselbund in Prioritätsreihenfolge: erster Eintrag = aktiver Schlüssel,
 * danach die übrigen Einträge und zuletzt die Wurzel (ohne Duplikate).
 */
function keyring(): KeyringEntry[] {
  const entries = new Map<string, KeyringEntry>();
  for (const ikm of [...keyringIkms(), secretBoxIkm()]) {
    const keyId = deriveKeyIdV3(ikm);
    const known = entries.get(keyId);
    if (known && known.ikm !== ikm) {
      throw new Error('Secret-Box-Schlüsselbund enthält eine doppelte Key-ID.');
    }
    if (!known) entries.set(keyId, { keyId, ikm });
  }
  return [...entries.values()];
}

/** Key-ID des Schlüssels, mit dem `encryptSecret` aktuell verschlüsselt. */
export function activeSecretBoxKeyId(): string {
  return keyring()[0]!.keyId;
}

/** Key-IDs aller entschlüsselnden Schlüssel (aktiver zuerst) — für Betriebsausgaben. */
export function configuredSecretBoxKeyIds(): string[] {
  return keyring().map((entry) => entry.keyId);
}

type ParsedBlob =
  | { version: 'v1' | 'v2'; keyId: null; iv: Buffer; tag: Buffer; ct: Buffer }
  | { version: 'v3'; keyId: string; iv: Buffer; tag: Buffer; ct: Buffer };

function parseSecretBlob(blob: string): ParsedBlob {
  const parts = blob.split(':');
  const version = parts[0];
  let keyId: string | null = null;
  let fields: string[];
  if (version === 'v3') {
    if (parts.length !== 5) throw new Error('Ungültiger Secret-Blob.');
    keyId = parts[1]!;
    if (!KEY_ID_PATTERN.test(keyId)) throw new Error('Ungültiger Secret-Blob.');
    fields = parts.slice(2);
  } else {
    if (parts.length !== 4) throw new Error('Ungültiger Secret-Blob.');
    if (version !== 'v1' && version !== 'v2') {
      throw new Error(`Unbekannte Secret-Blob-Version: ${version}`);
    }
    fields = parts.slice(1);
  }
  const [ivB64, tagB64, ctB64] = fields as [string, string, string];
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
  return keyId === null
    ? { version: version as 'v1' | 'v2', keyId, iv, tag, ct }
    : { version: 'v3', keyId, iv, tag, ct };
}

function v3Aad(keyId: string, context: string): Buffer {
  return Buffer.from(`${V3_AAD_LABEL}|${keyId}|${context}`, 'utf8');
}

function openGcm(key: Buffer, blob: ParsedBlob, aad?: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, blob.iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(blob.tag);
  return Buffer.concat([decipher.update(blob.ct), decipher.final()]).toString('utf8');
}

/** Kandidaten-IKMs für Blobs ohne Key-ID (bisheriger Schlüssel zuerst). */
function legacyIkms(version: 'v1' | 'v2'): string[] {
  const primary = version === 'v1' ? env.AUTH_SECRET : secretBoxIkm();
  return [...new Set([primary, ...keyringIkms()])];
}

/**
 * Verschlüsselt einen Plaintext für genau einen Ablageort. Leerer String →
 * leerer String. Schreibt immer im aktuellen Format (v3, aktiver Schlüssel,
 * Kontext als AAD).
 */
export function encryptSecret(plain: string, context: SecretContext): string {
  const aadContext = canonicalSecretContext(context);
  if (!plain) return '';
  const { keyId, ikm } = keyring()[0]!;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, deriveKeyV3(ikm), iv);
  cipher.setAAD(v3Aad(keyId, aadContext));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CURRENT_VERSION,
    keyId,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Entschlüsselt einen Wert von `encryptSecret`. v3 verlangt denselben Kontext
 * wie beim Verschlüsseln und einen konfigurierten Schlüssel mit passender
 * Key-ID; v1/v2 (ohne Kontextbindung) bleiben für Bestandsdaten lesbar. Wirft
 * bei Manipulation, fremdem Kontext, unbekanntem Schlüssel oder unbekannter
 * Version. Leerer Input → leerer Output.
 *
 * Migrations-Hinweis: v1/v2 werden beim nächsten Speichern als v3 geschrieben;
 * `pnpm secret-box:rewrap` stellt alle Bestandswerte ohne Klartextänderung auf
 * v3 mit dem aktiven Schlüssel um.
 */
export function decryptSecret(blob: string, context: SecretContext): string {
  const aadContext = canonicalSecretContext(context);
  if (!blob) return '';
  const parsed = parseSecretBlob(blob);
  if (parsed.version === 'v3') {
    const entry = keyring().find((candidate) => candidate.keyId === parsed.keyId);
    if (!entry) {
      throw new Error(
        `Secret-Box-Schlüssel ${parsed.keyId} ist nicht konfiguriert (SECRET_BOX_KEYRING/SECRET_BOX_KEY).`,
      );
    }
    return openGcm(deriveKeyV3(entry.ikm), parsed, v3Aad(parsed.keyId, aadContext));
  }
  let lastError: unknown;
  for (const ikm of legacyIkms(parsed.version)) {
    try {
      return openGcm(parsed.version === 'v1' ? deriveKeyV1(ikm) : deriveKeyV2(ikm), parsed);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Format und Key-ID eines Blobs ohne Entschlüsselung (für Betriebsstatistiken). */
export function describeSecretBlob(blob: string): {
  version: 'v1' | 'v2' | 'v3';
  keyId: string | null;
} {
  const parsed = parseSecretBlob(blob);
  return { version: parsed.version, keyId: parsed.keyId };
}

/** Ergebnis von `rewrapSecret`. */
export interface RewrapResult {
  /** Neuer bzw. unveränderter Blob. */
  blob: string;
  /** true, wenn der Blob neu verschlüsselt werden muss. */
  changed: boolean;
}

/**
 * Re-Wrap eines gespeicherten Werts: entschlüsselt mit dem Schlüsselbund und
 * verschlüsselt den unveränderten Klartext als v3 mit dem aktiven Schlüssel.
 * Bereits mit dem aktiven Schlüssel geschriebene v3-Werte bleiben unverändert
 * (idempotent), werden aber vollständig geprüft. Wirft, wenn der Wert nicht
 * entschlüsselbar ist oder die Selbstprüfung des neuen Blobs scheitert.
 */
export function rewrapSecret(blob: string, context: SecretContext): RewrapResult {
  const plain = decryptSecret(blob, context);
  if (!blob) return { blob, changed: false };
  const parsed = parseSecretBlob(blob);
  if (parsed.version === 'v3' && parsed.keyId === activeSecretBoxKeyId()) {
    return { blob, changed: false };
  }
  const next = encryptSecret(plain, context);
  if (decryptSecret(next, context) !== plain) {
    throw new Error('Re-Wrap-Selbstprüfung fehlgeschlagen.');
  }
  return { blob: next, changed: true };
}

/**
 * True, wenn der Wert wie ein gültiger Secret-Blob aussieht (zur sicheren
 * Migration von Klartext → verschlüsselt).
 *
 * M-4: ACHTUNG — reine Strukturheuristik (Prefix `v1:`/`v2:` + 4 Felder bzw.
 * `v3:<key-id>:` + 5 Felder). Kein Crypto-Check. Wenn jemand bewusst
 * `v2:a:b:c` als Klartext einträgt, würde looksEncrypted ein falsches `true`
 * liefern. Akzeptabel als Migrations-Gate (Klartext → encrypted erkennen),
 * NICHT als Sicherheits-Entscheidung. Vor schreibendem Pfad immer separat
 * versuchen `decryptSecret(value, context)` — schlägt das mit Manipulation
 * fehl, ist's kein echter Blob.
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(':');
  if (parts[0] === 'v3') return parts.length === 5 && KEY_ID_PATTERN.test(parts[1]!);
  return parts.length === 4 && (parts[0] === 'v1' || parts[0] === 'v2');
}

/**
 * Liest ein optional verschlüsseltes Setting-Feld: entschlüsselt den
 * `encrypted`-Wert für seinen Ablageort, fällt auf `legacyPlain`
 * (unverschlüsselte Altdaten) zurück, sonst leer. Ein Entschlüsselungsfehler
 * (z. B. Schlüssel fehlt im Schlüsselbund oder Wert in einen fremden Kontext
 * kopiert) wird NICHT still zu '' verschluckt, sondern an den optionalen
 * `onDecryptError`-Callback gemeldet — sonst scheitert etwa der
 * SMTP-/n8n-Auth kommentarlos. Vormals Kopie in apps/web (secret-box.ts);
 * jetzt hier, damit auch @taxtronik/mail sie ohne Web-Import nutzen kann.
 */
export function readEncryptedSetting(
  encrypted: string | undefined | null,
  legacyPlain: string | undefined | null,
  fieldName: string,
  context: SecretContext,
  onDecryptError?: (fieldName: string, err: Error) => void,
): string {
  if (encrypted && looksEncrypted(encrypted)) {
    try {
      return decryptSecret(encrypted, context);
    } catch (e) {
      onDecryptError?.(fieldName, e as Error);
      return '';
    }
  }
  if (typeof legacyPlain === 'string') return legacyPlain;
  return '';
}
