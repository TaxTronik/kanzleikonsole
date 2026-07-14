// =============================================================================
// Strukturierter Logger für die Web-App (M3)
//
// Bisher wurde im Auth-/n8n-/Revocation-Stack `console.warn` / `console.error`
// genutzt — inkonsistent zur Worker-App, die pino verwendet. Compliance-
// relevante Audit-Trails (Login-Fehler, Revocation-Events) sollten strukturiert
// vorliegen, damit ELK/Loki sie indexieren kann.
//
// Defensive Redaction: Felder, die typischerweise Secrets enthalten, werden
// hart durchgestrichen — auch wenn der Code-Pfad sie versehentlich loggt.
// =============================================================================

import pino from 'pino';
import { env } from '@taxtronik/config';

const SENSITIVE_LOG_FIELDS = [
  'password',
  'passwordHash',
  'secret',
  'token',
  'totpSecret',
  'totpSecretEnc',
  'signingTokenHash',
  'signingOtpHash',
  'hmacSecret',
  'apiKey',
  'link',
  'devSignInUrl',
] as const;

// fast-redact's `*.field` only matches nested properties, not root fields.
// Exporting the effective paths lets the regression test exercise the exact
// same configuration used by the application logger.
export const LOG_REDACT_PATHS = SENSITIVE_LOG_FIELDS.flatMap((field) => [field, `*.${field}`]);

export const log = pino({
  // Manche isolierten Unit-Tests mocken nur den jeweils relevanten ENV-
  // Ausschnitt. Runtime-Config liefert LOG_LEVEL immer; der Fallback hält den
  // Logger auch bei solchen Teil-Mocks deterministisch.
  level: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  // Pretty in Dev, JSON in Prod (Standard-Pino-Setup, kompatibel zu Worker).
  transport:
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  redact: {
    paths: [
      ...LOG_REDACT_PATHS,
      // L-3: link-Property kann Magic-Link-URL mit eingebettetem Token enthalten.
      // Auch in Production redacten — falls jemand versehentlich auch
      // im Prod-Modus magic-link-Logs aktiv lässt.
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[redacted]',
  },
});
