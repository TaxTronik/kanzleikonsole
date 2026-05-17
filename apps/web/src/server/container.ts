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
  Rfc3161HttpAdapter,
} from '@taxtronik/evidence';

// C2: Stub-Adapter wirft unbedingt — der echte HTTP-Adapter ist seit Iter. 18
// produktionsreif (siehe evidence-seal.ts). Bei konfigurierter TSA-URL den
// HTTP-Adapter benutzen.
const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? new Rfc3161HttpAdapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();

export const evidenceService = new EvidenceService(timestampPort);

// Storage-Service (kein Singleton nötig — der S3-Client ist bereits Singleton
// in packages/storage/src/client.ts). Funktionen direkt importieren:
// import { commitDocumentFromBytes, fetchObjectBytes } from '@taxtronik/storage';
