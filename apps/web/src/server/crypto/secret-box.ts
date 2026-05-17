// =============================================================================
// Re-Export aus @taxtronik/crypto (M-7).
//
// Vorher: eigenständige Kopie der Verschlüsselungs-Funktionen in web + worker.
// Jetzt: zentrale Quelle in @taxtronik/crypto. Diese Datei bleibt als
// Re-Export erhalten, damit bestehende Imports `from '@/server/crypto/secret-box'`
// nicht angefasst werden müssen.
// =============================================================================

export { encryptSecret, decryptSecret, looksEncrypted } from '@taxtronik/crypto';
