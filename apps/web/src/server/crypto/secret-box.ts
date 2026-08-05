// =============================================================================
// Re-Export aus @taxtronik/crypto (M-7).
//
// Vorher: eigenständige Kopie der Verschlüsselungs-Funktionen in web + worker.
// Jetzt: zentrale Quelle in @taxtronik/crypto. Diese Datei bleibt als
// Re-Export erhalten, damit bestehende Imports `from '@/server/crypto/secret-box'`
// nicht angefasst werden müssen. readEncryptedSetting lebt ebenfalls dort
// (auch @taxtronik/mail nutzt es) — hier nur noch die Web-Logger-Bindung.
// =============================================================================

import { readEncryptedSetting as readEncryptedSettingCore } from '@taxtronik/crypto';
import { log } from '@/server/logger';

export { encryptSecret, decryptSecret, looksEncrypted } from '@taxtronik/crypto';

/**
 * Liest ein optional verschlüsseltes Setting-Feld: entschlüsselt den
 * `encrypted`-Wert, fällt auf `legacyPlain` (unverschlüsselte Altdaten) zurück,
 * sonst leer. Ein Entschlüsselungsfehler (z. B. nach AUTH_SECRET-/SECRET_BOX_KEY-
 * Rotation ohne Re-Wrap) wird NICHT still zu '' verschluckt, sondern geloggt —
 * sonst scheitert etwa der SMTP-/n8n-Auth kommentarlos.
 */
export function readEncryptedSetting(
  encrypted: string | undefined | null,
  legacyPlain: string | undefined | null,
  fieldName: string,
): string {
  return readEncryptedSettingCore(encrypted, legacyPlain, fieldName, (field, e) =>
    log.warn(
      { component: 'secret-box', field, err: e.message },
      'readEncryptedSetting: Entschlüsselung fehlgeschlagen (Key-Rotation ohne Re-Wrap?)',
    ),
  );
}
