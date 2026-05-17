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

export const log = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Pretty in Dev, JSON in Prod (Standard-Pino-Setup, kompatibel zu Worker).
  transport:
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
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
      // L-3: link-Property kann Magic-Link-URL mit eingebettetem Token enthalten.
      // Auch in Production redacten — falls jemand versehentlich auch
      // im Prod-Modus magic-link-Logs aktiv lässt.
      '*.link',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[redacted]',
  },
});
