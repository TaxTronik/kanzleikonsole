// =============================================================================
// Re-Export aus @taxtronik/crypto (M-7).
//
// Vorher: eigenständige Kopie der Verschlüsselungs-Funktionen in web + worker.
// Jetzt: zentrale Quelle in @taxtronik/crypto. Diese Datei bleibt als
// Re-Export erhalten, damit bestehende Imports `from '@/server/crypto/secret-box'`
// nicht angefasst werden müssen. readEncryptedSetting lebt ebenfalls dort
// (auch @taxtronik/mail nutzt es) — hier nur noch die Web-Logger-Bindung.
// =============================================================================

import {
  readEncryptedSetting as readEncryptedSettingCore,
  type SecretContext,
} from '@taxtronik/crypto';
import { log } from '@/server/logger';

export {
  encryptSecret,
  decryptSecret,
  looksEncrypted,
  SECRET_SLOTS,
  secretSlotContext,
  type SecretContext,
} from '@taxtronik/crypto';

/**
 * Liest ein optional verschlüsseltes Setting-Feld: entschlüsselt den
 * `encrypted`-Wert, fällt auf `legacyPlain` (unverschlüsselte Altdaten) zurück,
 * sonst leer. Ein Entschlüsselungsfehler (z. B. Schlüssel fehlt im
 * Schlüsselbund oder Wert in einen fremden Kontext kopiert) wird NICHT still
 * zu '' verschluckt, sondern geloggt — sonst scheitert etwa der SMTP-/n8n-Auth
 * kommentarlos. `context` bindet den Wert an seinen Ablageort (S-08).
 */
export function readEncryptedSetting(
  encrypted: string | undefined | null,
  legacyPlain: string | undefined | null,
  fieldName: string,
  context: SecretContext,
): string {
  return readEncryptedSettingCore(encrypted, legacyPlain, fieldName, context, (field, e) =>
    log.warn(
      { component: 'secret-box', field, err: e.message },
      'readEncryptedSetting: Entschlüsselung fehlgeschlagen (Key-Rotation ohne Re-Wrap?)',
    ),
  );
}
