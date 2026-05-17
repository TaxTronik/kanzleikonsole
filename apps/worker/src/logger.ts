// =============================================================================
// Strukturierter Logger für den Worker-Prozess
//
// N7: Defensive Redaction für Felder, die typischerweise Secrets enthalten —
// spiegelt apps/web/src/server/logger.ts. Worker-Jobs loggen tenantId,
// documentVersionId, bucket, storageKey aktuell, aber falls künftig Job-
// Payloads Tokens/Secrets enthalten, leakt das nicht ungeschützt ins Log.
// =============================================================================

import pino from 'pino';

export const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
  redact: {
    paths: [
      '*.password',
      '*.passwordHash',
      '*.secret',
      '*.token',
      '*.totpSecret',
      '*.totpSecretEnc',
      '*.signingTokenHash',
      '*.signingOtpHash',
      '*.hmacSecret',
      '*.apiKey',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[redacted]',
  },
});
