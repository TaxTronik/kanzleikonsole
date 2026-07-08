// =============================================================================
// Composition-Root — Service-Verdrahtung
//
// Alle Singleton-Services werden hier einmalig instanziiert und exportiert.
// Server Components, Route Handlers und Server Actions importieren von hier.
// =============================================================================

import { env } from '@taxtronik/config';
import {
  EvidenceService,
  LocalTimestampAdapter,
  createRfc3161Adapter,
} from '@taxtronik/evidence';

// C2: Stub-Adapter wirft unbedingt — der echte HTTP-Adapter ist seit Iter. 18
// produktionsreif (siehe evidence-seal.ts). Bei konfigurierter TSA-URL den
// HTTP-Adapter benutzen. createRfc3161Adapter verdrahtet die aufgelösten
// Trust-Roots (Default + optionale Operator-Roots via TSA_TRUSTED_ROOTS_FILE).
const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? createRfc3161Adapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();

export const evidenceService = new EvidenceService(timestampPort);

// Storage-Service (kein Singleton nötig — der S3-Client ist bereits Singleton
// in packages/storage/src/client.ts). Funktionen direkt importieren:
// import { commitDocumentFromBytes, fetchObjectBytes } from '@taxtronik/storage';
