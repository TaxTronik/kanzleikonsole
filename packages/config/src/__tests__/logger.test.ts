import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS, SENSITIVE_LOG_FIELDS } from '../logger';

describe('gemeinsame Logger-Redaction', () => {
  it.each(SENSITIVE_LOG_FIELDS)('schuetzt %s auf Root- und Wildcard-Ebene', (field) => {
    expect(LOG_REDACT_PATHS).toContain(field);
    expect(LOG_REDACT_PATHS).toContain(`*.${field}`);
  });

  it('enthaelt die sensiblen Request-Header und keine doppelten Pfade', () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers.cookie');
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(new Set(LOG_REDACT_PATHS).size).toBe(LOG_REDACT_PATHS.length);
  });
});
