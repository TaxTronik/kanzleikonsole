// =============================================================================
// Konfigurationsprüfung im Worker-Image (B-05 a), gebündelt als
// dist/env-check.js neben dist/index.js (scripts/build.mjs).
//
// Prüft die ENV der Prozesse `web` und `worker` mit genau dem Schema aus
// @taxtronik/config, mit dem beide starten, bricht aber nicht beim ersten
// Befund ab: Jeder Schemafehler und jede Prüfung erscheint als eigene Zeile.
// Die Operator-CLI ruft sie im Ziel-Image vor Backup und Migration auf
// (./taxtronik deploy|update, assert_app_env_schema) und zeigt die Zeilen in
// `./taxtronik doctor`.
//
//   node dist/env-check.js [--profile web|worker]...   (ohne Angabe: beide)
//
// Ausgabe je Befund eine Zeile im doctor-Format (FEHLT/WARN/OK, Profil,
// Meldung); keine Werte, nur die [config]-Meldungen. Exit 1 bei mindestens
// einem Fehler, 2 bei falschem Aufruf, sonst 0 (Warnungen blockieren nicht).
// Importiert bewusst nur das seiteneffektfreie Schema-Modul, nicht
// @taxtronik/config selbst (das validiert beim Import die Prozess-ENV).
// =============================================================================

import { pathToFileURL } from 'node:url';
import { checkEnvProfileFrom } from '@taxtronik/config/env-schema';

export const ENV_CHECK_PROFILES = ['web', 'worker'] as const;
export type EnvCheckProfile = (typeof ENV_CHECK_PROFILES)[number];

type Status = 'FEHLT' | 'WARN' | 'OK';

/** Zeile im Format von `./taxtronik doctor` (Status, Schluessel, Meldung). */
export function envCheckRow(status: Status, profile: EnvCheckProfile, message: string): string {
  return `  ${status.padEnd(8)} ${`SCHEMA_${profile.toUpperCase()}`.padEnd(22)} ${message}`;
}

/** Profile aus den Argumenten; wirft bei unbekannten Argumenten. */
export function parseEnvCheckProfiles(args: readonly string[]): EnvCheckProfile[] {
  const selected: EnvCheckProfile[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] === '--profile' ? args[(index += 1)] : undefined;
    if (!ENV_CHECK_PROFILES.includes(value as EnvCheckProfile)) {
      throw new Error(
        `[env-check] Nutzung: env-check.js [--profile web|worker]... (unbekannt: ${args.join(' ')})`,
      );
    }
    if (!selected.includes(value as EnvCheckProfile)) selected.push(value as EnvCheckProfile);
  }
  return selected.length > 0 ? selected : [...ENV_CHECK_PROFILES];
}

/** Prüft die gewählten Profile gegen `source`; Rückgabe ist der Exit-Code. */
export function runEnvCheck(
  args: readonly string[],
  source: NodeJS.ProcessEnv,
  write: (line: string) => void,
): number {
  let profiles: EnvCheckProfile[];
  try {
    profiles = parseEnvCheckProfiles(args);
  } catch (error) {
    write((error as Error).message);
    return 2;
  }
  let failed = false;
  for (const profile of profiles) {
    const { errors, warnings } = checkEnvProfileFrom(profile, source);
    for (const message of errors) write(envCheckRow('FEHLT', profile, message));
    for (const message of warnings) write(envCheckRow('WARN', profile, message));
    if (errors.length === 0) {
      write(envCheckRow('OK', profile, 'Schema und Pruefungen der App bestanden'));
    } else {
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// Nur als Einstieg ausführen, nicht beim Import durch Tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runEnvCheck(process.argv.slice(2), process.env, (line) => console.log(line));
}
