// =============================================================================
// ENV des Worker-Prozesses mit dem Typ des Profils „worker“ (Review-Befund K-09).
//
// index.ts wählt mit seinem ersten Import das Profil „worker“; @taxtronik/config
// validiert damit beim Start genau die Worker-Teile. Exportiert wird `env` aber
// mit dem Typ des Web-Profils, sodass tsc auch Felder anderer Prozesse
// (NEXTAUTH_TRUST_HOST, ELSTER_*, LICENSE_*, …) zulässt, die im Worker erst zur
// Laufzeit werfen. Worker-Module lesen die ENV deshalb hier: derselbe
// validierte Wert, typisiert als WorkerEnv (NEXTAUTH_URL ist im Worker nur
// optionaler Fallback der Link-Basis). eslint.config.mjs hält Worker-Module
// von `env` aus @taxtronik/config fern.
// =============================================================================

import { env as processEnv } from '@taxtronik/config';
import type { WorkerEnv } from '@taxtronik/config/env-schema';

export type { WorkerEnv };

export const env: WorkerEnv = processEnv;
