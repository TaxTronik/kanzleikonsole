// =============================================================================
// taxtronik — validierte ENV des Prozesses (Zod)
//
// Wird beim ersten Import dieses Moduls geladen und validiert. Bei Fehlern:
// Crash beim Start mit klarer Fehlermeldung. Niemals stillschweigend
// Defaults für Secrets verwenden.
//
// Validiert wird das Profil des Prozesses (./profile.ts): `web` (Next.js, alle
// Teile — ohne Wahl), `worker` oder ein CLI-Profil. Schema-Teile, Profile und
// Produktions-Prüfungen stehen in ./env-schema.ts. In einem anderen Profil als
// `web` wirft der Zugriff auf ein Feld, das nur andere Prozesse brauchen.
// =============================================================================

import {
  elsterConfigOf,
  envProfileHasPart,
  envProfileKeys,
  n8nDeliveryModeOf,
  parseEnvProfileFrom,
  riskLayerConfigOf,
  type ElsterConfig,
  type Env,
  type EnvProfileName,
  type N8nDeliveryMode,
  type RiskLayerConfig,
} from './env-schema';
import { markEnvLoaded, selectedEnvProfile } from './profile';

export type {
  ElsterConfig,
  Env,
  EnvPartName,
  EnvProfileName,
  N8nDeliveryMode,
  ProfileEnv,
  RiskLayerConfig,
  WorkerEnv,
} from './env-schema';
export { parseEnvProfileFrom } from './env-schema';

/**
 * Exportiert für Unit-Tests (Audit Round 15): die Dev-Default-Denylist und
 * Cross-Field-Validierung dürfen nicht ungetestet bleiben. Test-Code ruft
 * `parseEnvFrom(env)` mit einer kontrollierten Pseudo-ENV statt globalem
 * `process.env` (Web-Profil; andere Profile: `parseEnvProfileFrom`).
 */
export function parseEnvFrom(source: NodeJS.ProcessEnv): Env {
  return parseEnvProfileFrom('web', source);
}

const WEB_KEYS = envProfileKeys('web');

/** Außerhalb des Web-Profils: Zugriff auf profilfremde Felder wirft statt `undefined`. */
function guarded(data: Partial<Env>, profile: EnvProfileName): Env {
  if (profile === 'web') return data as Env;
  const allowed = envProfileKeys(profile);
  return new Proxy(data, {
    get(target, key, receiver) {
      if (typeof key === 'string' && WEB_KEYS.has(key) && !allowed.has(key)) {
        throw new Error(
          `[config] ${key} gehört nicht zum ENV-Profil „${profile}“ dieses Prozesses ` +
            '(packages/config/src/env-schema.ts).',
        );
      }
      return Reflect.get(target, key, receiver);
    },
  }) as Env;
}

const profile = selectedEnvProfile();
const data = parseEnvProfileFrom(profile, process.env) as Partial<Env> & Pick<Env, 'NODE_ENV'>;
markEnvLoaded(profile);

export const env: Env = guarded(data, profile);

/**
 * Public-Basis-URL für alle an MANDANTEN versendeten Links (Magic-Link,
 * GwG-Onboarding, Portal-Formular). Zeigt auf die Mandanten-Subdomain,
 * damit Portal-Cookies auf der richtigen Domain landen. Fällt auf
 * NEXTAUTH_URL zurück, wenn keine getrennte Portal-Domain konfiguriert
 * ist (Single-Host-Deploy). Trailing-Slash wird entfernt. Leer in Profilen
 * ohne Portal-Links (CLI-Profile versenden keine Mandanten-Links).
 */
export const portalBaseUrl: string = envProfileHasPart(profile, 'portalLinks')
  ? (data.PORTAL_PUBLIC_URL ?? data.NEXTAUTH_URL ?? '').replace(/\/$/, '')
  : '';

/** Risk-Layer-Engine (§4) oder `null`, wenn nicht deployt (siehe env-schema.ts). */
export const riskLayerConfig: RiskLayerConfig | null = envProfileHasPart(profile, 'riskLayer')
  ? riskLayerConfigOf(data)
  : null;

/**
 * Konfiguration der ELSTER-Bridge (eric-bridge) oder `null`, wenn nicht
 * deployt. Gleiches Muster wie `riskLayerConfig`: `null` ist ein gültiger
 * Zustand — ohne Bridge bleibt das ELSTER-Modul unsichtbar. Der
 * `@taxtronik/elster`-Client wirft bei `null` eine klare
 * `ElsterNotConfiguredError`. Trailing-Slash wird entfernt.
 */
export const elsterConfig: ElsterConfig | null = envProfileHasPart(profile, 'elster')
  ? elsterConfigOf(data)
  : null;

/** n8n-Liefer-Modus mit sicherem Default aus NODE_ENV (siehe env-schema.ts). */
export const n8nDeliveryMode: N8nDeliveryMode = n8nDeliveryModeOf(data);
