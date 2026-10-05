// =============================================================================
// Gemeinsame Bausteine der Hardware-Anmeldung (WebAuthn): Fehlerklassen und
// Schlüsselgrenzen. P-23 hat das frühere Sammelmodul webauthn.ts in Metadaten,
// Zeremonien, Verifikation und Login aufgeteilt; webauthn.ts re-exportiert die
// öffentliche Schnittstelle unverändert.
// =============================================================================

export const HARDWARE_ONLY_MIN_KEYS = 2;
export const HARDWARE_KEY_LIMIT = 10;

export class HardwareAccessUnavailableError extends Error {
  constructor(
    message = 'Sicherheitsschlüssel sind derzeit nicht verfügbar.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HardwareAccessUnavailableError';
  }
}

export class HardwareAccessVerificationError extends Error {
  constructor(
    message = 'Der Sicherheitsschlüssel konnte nicht verifiziert werden.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HardwareAccessVerificationError';
  }
}
