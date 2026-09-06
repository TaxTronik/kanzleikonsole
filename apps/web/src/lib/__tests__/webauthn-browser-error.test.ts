// Fachkatalog: ACCESS-TENANT-RLS-001
import { WebAuthnError } from '@simplewebauthn/browser';
import { describe, expect, it } from 'vitest';
import { isWebAuthnNotAllowedError } from '../webauthn-browser-error';

describe('WebAuthn-Browserfehler', () => {
  it('erkennt den von SimpleWebAuthn umschlossenen NotAllowedError', () => {
    const cause = new Error('cancelled');
    cause.name = 'NotAllowedError';
    const wrapped = new WebAuthnError({
      message: 'cancelled',
      code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
      cause,
    });

    expect(wrapped).not.toBeInstanceOf(DOMException);
    expect(isWebAuthnNotAllowedError(wrapped)).toBe(true);
  });

  it('verwechselt andere oder unstrukturierte Fehler nicht mit einem Abbruch', () => {
    expect(isWebAuthnNotAllowedError(new Error('network'))).toBe(false);
    expect(isWebAuthnNotAllowedError(null)).toBe(false);
    expect(isWebAuthnNotAllowedError({ name: 'SecurityError' })).toBe(false);
  });
});
