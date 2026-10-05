// =============================================================================
// Hardware-Anmeldung mit FIDO2-Sicherheitsschlüsseln — öffentliche Schnittstelle
//
// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-TENANT-RLS-001
//
// P-23: Das frühere Sammelmodul ist aufgeteilt in
//   - webauthn-metadata.ts      gespeicherter, signaturgeprüfter FIDO-MDS-Stand,
//                               Hardware-Policy und Modellbewertung
//   - webauthn-ceremony.ts      Relying Party, Challenges, Zeremonie-Start
//   - webauthn-verification.ts  Registrierungs- und Assertion-Prüfung
//   - webauthn-login.ts         Hardware-Login mit Audit und Commit-Bindung
//   - webauthn-shared.ts        Fehlerklassen und Schlüsselgrenzen
// Den MDS-BLOB lädt und prüft ausschließlich der Worker-Job fido-mds-refresh;
// kein Anmelde- oder Registrierungsrequest kontaktiert mds.fidoalliance.org.
// Diese Datei re-exportiert die bisherige Schnittstelle unverändert.
// =============================================================================

export {
  HARDWARE_KEY_LIMIT,
  HARDWARE_ONLY_MIN_KEYS,
  HardwareAccessUnavailableError,
  HardwareAccessVerificationError,
} from './webauthn-shared';
export {
  initializeHardwareAccessPolicy,
  lockMatchingHardwareMetadataSerial,
  resetHardwareMetadataCacheForTests,
} from './webauthn-metadata';
export {
  beginHardwareLogin,
  beginHardwareModeAssertion,
  beginHardwareRegistration,
  consumeHardwareCeremony,
  isAuthenticationResponse,
  isHardwareAccessConfigured,
  isRegistrationResponse,
  parseAuthenticationResponse,
  parseTransports,
  type HardwareCeremony,
  type HardwareCeremonyPurpose,
} from './webauthn-ceremony';
export {
  assertStoredHardwareCredentialTrusted,
  verifyHardwareAssertion,
  verifyHardwareRegistration,
  type HardwareCredentialTrustInput,
  type StoredHardwareCredential,
  type VerifiedHardwareAssertion,
  type VerifiedHardwareRegistration,
} from './webauthn-verification';
export { authenticateStaffHardwareCredential, type HardwareLoginUser } from './webauthn-login';
