// =============================================================================
// Composition-Root — Service-Verdrahtung
//
// Alle Singleton-Services werden hier einmalig instanziiert und exportiert.
// Server Components, Route Handlers und Server Actions importieren von hier.
// =============================================================================

import { env } from '@taxtronik/config';
import { EvidenceService, createRfc3161Adapter, resolveTsaUrl } from '@taxtronik/evidence';

// C2: Der echte HTTP-Adapter ist produktionsreif (siehe evidence-seal.ts).
// Auswahl wie im Worker: ENV, danach GlobalSign-Default. Die Factory verdrahtet
// die aufgeloesten Trust-Roots (Default + optionale Operator-Roots via
// TSA_TRUSTED_ROOTS_FILE).
const timestampUrl = env.TIMESTAMP_AUTHORITY_URL?.trim() || resolveTsaUrl('globalsign', null);
if (!timestampUrl) throw new Error('GlobalSign-TSA-Preset fehlt.');
const timestampPort = createRfc3161Adapter(timestampUrl);

export const evidenceService = new EvidenceService(timestampPort);

// Storage-Service (kein Singleton nötig — der S3-Client ist bereits Singleton
// in packages/storage/src/client.ts). Funktionen direkt importieren:
// import { commitDocumentFromBytes, fetchObjectBytes } from '@taxtronik/storage';
