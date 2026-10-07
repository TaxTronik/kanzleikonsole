// =============================================================================
// Strukturierter Logger für den Worker-Prozess
//
// N7: Defensive Redaction für Felder, die typischerweise Secrets enthalten —
// spiegelt apps/web/src/server/logger.ts. Worker-Jobs loggen tenantId,
// documentVersionId, bucket, storageKey aktuell, aber falls künftig Job-
// Payloads Tokens/Secrets enthalten, leakt das nicht ungeschützt ins Log.
//
// F-06: Jede Zeile, die während eines Jobs entsteht, trägt `queue` und `jobId`
// (log-context.ts, gesetzt von createWorker). Ausdrücklich geloggte Felder
// gleichen Namens haben Vorrang.
// =============================================================================

import pino from 'pino';
import { LOG_REDACT_PATHS } from '@taxtronik/config/logger';
import { currentJobLogContext } from './log-context';

export { LOG_REDACT_PATHS } from '@taxtronik/config/logger';

/** pino-Mixin: Queue und Job-ID des laufenden Jobs an jede Logzeile. */
export function jobLogFields(): { queue?: string; jobId?: string | null } {
  const context = currentJobLogContext();
  return context ? { queue: context.queue, jobId: context.jobId } : {};
}

/**
 * Baut den Worker-Logger. Mit `destination` (Tests) schreibt er JSON direkt in
 * diesen Stream, ohne den Pretty-Transport der Entwicklung.
 */
export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport:
      process.env['NODE_ENV'] === 'production' || destination
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true } },
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: '[redacted]',
    },
    mixin: jobLogFields,
  };
  return destination ? pino(options, destination) : pino(options);
}

export const log = createLogger();
