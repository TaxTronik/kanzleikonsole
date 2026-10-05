// =============================================================================
// Update-Manifest im Web-Prozess.
//
// Die Prüflogik (Signatur, striktes Schema, Größen-/Zeitgrenzen) liegt in
// @taxtronik/config/update-manifest, damit der Worker-Job `update-check` sie
// ebenfalls nutzt (P-21). Die Admin-Übersicht ruft den Update-Server nicht mehr
// auf, sondern liest das vom Worker gespeicherte Ergebnis.
// =============================================================================

import { checkForUpdates as checkManifest } from '@taxtronik/config/update-manifest';
import { safeFetchPublic } from '@/server/http/ssrf-guard';

export {
  evaluateStoredUpdateCheck,
  UPDATE_CHECK_RESULT_SETTING_KEY,
  type CheckResult,
  type ReleaseArtifact,
  type StoredUpdateStatus,
  type UpdateManifest,
  type VersionEntry,
} from '@taxtronik/config/update-manifest';

/** Prüft das Manifest mit dem SSRF-geschützten Fetch des Web-Prozesses. */
export function checkForUpdates(currentVersion: string) {
  return checkManifest(currentVersion, (url, init) => safeFetchPublic(url, init));
}
