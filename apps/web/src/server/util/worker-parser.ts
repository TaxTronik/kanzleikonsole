// =============================================================================
// Parser für begrenzte Worker-Threads (P-22, P-13)
//
// Ein Worker-Thread (@taxtronik/mail/bounded-worker) lädt seinen Parser
// (pdf-lib, unpdf, mammoth) als echtes Node-Modul aus node_modules. Der
// Servercode darf den Pfad dafür nicht per require.resolve ermitteln:
// Turbopack ersetzt require.resolve('…') im Produktionsbuild durch eine
// Modul-ID, die der Thread nicht laden kann. Der Thread löst deshalb selbst
// auf, ausgehend vom Serverskript bzw. Arbeitsverzeichnis (Standalone:
// /app/apps/web/server.js bzw. /app; Entwicklung und Tests: das gehoistete
// node_modules des Repos). Dass die Parser samt Abhängigkeiten im
// Standalone-Paket liegen und dort ladbar sind, sichern next.config.mjs
// (outputFileTracingIncludes) und scripts/verify-standalone-trace.mjs.
// =============================================================================

import { join } from 'node:path';

/** Pakete, die Worker-Threads der Web-App zur Laufzeit laden. */
export const WORKER_PARSER_PACKAGES = ['pdf-lib', 'unpdf', 'mammoth'] as const;

/**
 * Quelltext für ein festes Worker-Programm (nach der Zeile, die `workerData`
 * aus node:worker_threads holt): definiert `loadParser(name)`. Ein Fehler beim
 * Laden wird nicht abgefangen, damit ihn der Aufrufer vom Lesefehler einer
 * Datei unterscheiden kann (Worker-Ereignis `error`).
 */
export const LOAD_PARSER_SOURCE = `
const { createRequire } = require('node:module');
function loadParser(name) {
  let lastError;
  for (const base of workerData.parserBases) {
    try {
      return createRequire(base)(name);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Kein Suchpfad für ' + name);
}
`;

/** Ausgangspunkte für loadParser, zur Laufzeit ermittelt (nicht beim Build). */
export function workerParserBases(): string[] {
  return [process.argv[1], join(process.cwd(), 'worker-parser.js')].filter(
    (base): base is string => typeof base === 'string' && base.length > 0,
  );
}
