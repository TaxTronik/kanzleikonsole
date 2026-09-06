/**
 * SimpleWebAuthn wraps native DOMExceptions in WebAuthnError while preserving
 * the WebAuthn exception name. Structural matching covers both representations
 * without coupling UI code to a package-internal prototype.
 */
export function isWebAuthnNotAllowedError(caught: unknown): boolean {
  return (
    caught !== null &&
    typeof caught === 'object' &&
    'name' in caught &&
    caught.name === 'NotAllowedError'
  );
}
