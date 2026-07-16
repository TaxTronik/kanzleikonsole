// =============================================================================
// Gemeinsame Pino-Redaction fuer Web und Worker.
//
// fast-redact behandelt `field` und `*.field` als unterschiedliche Pfade:
// der erste schuetzt Root-Level-Logs, der zweite Felder in einem geloggten
// Objekt. Beide Varianten werden deshalb immer gemeinsam erzeugt.
// =============================================================================

export const SENSITIVE_LOG_FIELDS = [
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

const SENSITIVE_REQUEST_PATHS = ['req.headers.cookie', 'req.headers.authorization'] as const;

export const LOG_REDACT_PATHS = [
  ...SENSITIVE_LOG_FIELDS.flatMap((field) => [field, `*.${field}`]),
  ...SENSITIVE_REQUEST_PATHS,
] as const;
