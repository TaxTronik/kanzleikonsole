// =============================================================================
// Prozessprofil der ENV-Validierung (Profile und Teile: ./env-schema.ts).
//
// ./env.ts validiert beim ersten Import das hier gewählte Profil; ohne Wahl
// gilt `web`. Worker und CLI-Skripte wählen ihr Profil über einen Seiteneffekt-
// Import als ERSTEN Import ihres Einstiegsmoduls (./profiles/*), damit die
// Auswahl vor jeder Auswertung von @taxtronik/config steht.
// =============================================================================

import type { EnvProfileName } from './env-schema';

let selected: EnvProfileName = 'web';
let loaded: EnvProfileName | null = null;

/** Wählt das Profil des Prozesses; wirft, wenn die ENV schon anders validiert ist. */
export function selectEnvProfile(profile: EnvProfileName): void {
  if (loaded !== null && loaded !== profile) {
    throw new Error(
      `[config] ENV wurde bereits für das Profil „${loaded}“ validiert. Das Profil „${profile}“ ` +
        'muss vor jedem anderen Import gewählt werden (erster Import des Einstiegsmoduls).',
    );
  }
  selected = profile;
}

export function selectedEnvProfile(): EnvProfileName {
  return selected;
}

/** Von ./env.ts nach der Validierung gesetzt. */
export function markEnvLoaded(profile: EnvProfileName): void {
  loaded = profile;
}
