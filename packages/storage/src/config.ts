// =============================================================================
// Konfiguration von Object-Store und Virenscanner, gelesen beim ersten Zugriff
// (Review-Befund K-09).
//
// Früher las das Paket `env` aus @taxtronik/config: schon der Import validierte
// die ganze Prozess-ENV und baute den S3-Client, jeder Test brauchte deshalb
// eine Minimal-ENV. Jetzt validiert erst der erste Zugriff genau die Teile, die
// das Paket braucht: Core, S3 und ClamAV, das Profil „cli-storage“ aus
// packages/config/src/env-schema.ts. Felder, Defaults, Produktionsprüfungen und
// Fehlermeldungen sind dieselben wie bei der Boot-Validierung von Web, Worker
// und `pnpm verify:deploy`; eine fehlende oder ungültige Angabe scheitert also
// mit demselben Fehler, nur beim ersten Zugriff statt beim Import.
// =============================================================================

import { parseEnvProfileFrom, type ProfileEnv } from '@taxtronik/config/env-schema';

export type StorageConfig = ProfileEnv<'cli-storage'>;

let validated: StorageConfig | undefined;

/**
 * Validierte Storage-Konfiguration des Prozesses. Der erste erfolgreiche Aufruf
 * liest die Prozess-ENV; danach bleibt der Wert fest wie zuvor die beim Import
 * validierte ENV. Ein fehlgeschlagener Aufruf wirft bei jedem Zugriff erneut.
 */
export function storageConfig(): StorageConfig {
  validated ??= parseEnvProfileFrom('cli-storage', process.env);
  return validated;
}
