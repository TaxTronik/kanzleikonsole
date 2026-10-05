// =============================================================================
// WebAuthn-Zeremonien der Hardware-Anmeldung (P-23: aus webauthn.ts gelöst)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Relying Party, einmalige Challenges in Redis (fünf Minuten, atomar
// verbraucht), Start von Login, Registrierung und Modus-Assertions sowie das
// Einlesen der Browser-Antworten.
// =============================================================================

import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';
import { configuredHardwarePolicy, ensureHardwareMetadataReady } from './webauthn-metadata';
import { HardwareAccessUnavailableError, HardwareAccessVerificationError } from './webauthn-shared';

const CEREMONY_TTL_SECONDS = 5 * 60;
const RESPONSE_JSON_MAX_CHARS = 128 * 1024;
const CEREMONY_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export type HardwareCeremonyPurpose =
  | 'login'
  | 'register'
  | 'mode-enable'
  | 'mode-disable'
  | 'admin-recovery';

export type HardwareCeremony = {
  version: 1;
  purpose: HardwareCeremonyPurpose;
  challenge: string;
  origin: string;
  rpID: string;
  staffId?: string;
  tenantId?: string;
  targetStaffId?: string;
  authRevision?: number;
};

export function isHardwareAccessConfigured(): boolean {
  try {
    if (!configuredHardwarePolicy().enabled) return false;
    relyingParty();
    return true;
  } catch {
    return false;
  }
}

function relyingParty(): { origin: string; rpID: string } {
  const configured = new URL(env.NEXTAUTH_URL);
  const hostname = configured.hostname.replace(/^\[|\]$/g, '');
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (configured.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && local)) {
    throw new HardwareAccessUnavailableError(
      'Sicherheitsschlüssel benötigen eine konfigurierte HTTPS-Adresse.',
    );
  }
  return { origin: configured.origin, rpID: hostname };
}

function ceremonyKey(id: string): string {
  return `staff-webauthn:ceremony:${id}`;
}

async function storeCeremony(
  value: Omit<HardwareCeremony, 'version' | 'origin' | 'rpID'>,
): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new HardwareAccessUnavailableError();
  const id = randomBytes(24).toString('base64url');
  const rp = relyingParty();
  const ceremony: HardwareCeremony = { version: 1, ...value, ...rp };
  try {
    const stored = await redis.set(
      ceremonyKey(id),
      JSON.stringify(ceremony),
      'EX',
      CEREMONY_TTL_SECONDS,
      'NX',
    );
    if (stored !== 'OK') throw new Error('ceremony id collision');
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'WebAuthn-Zeremonie konnte nicht gespeichert werden',
    );
    throw new HardwareAccessUnavailableError(undefined, { cause: error });
  }
  return id;
}

const CONSUME_CEREMONY_LUA = `
local value = redis.call('GET', KEYS[1])
if not value then
  return false
end
redis.call('DEL', KEYS[1])
return value
`;

export async function consumeHardwareCeremony(input: {
  ceremonyId: string;
  purpose: HardwareCeremonyPurpose;
  staffId?: string;
  tenantId?: string;
  targetStaffId?: string;
  authRevision?: number;
}): Promise<HardwareCeremony> {
  if (!CEREMONY_ID_PATTERN.test(input.ceremonyId)) {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }
  const redis = getRedis();
  if (!redis) throw new HardwareAccessUnavailableError();

  let raw: unknown;
  try {
    raw = await redis.eval(CONSUME_CEREMONY_LUA, 1, ceremonyKey(input.ceremonyId));
  } catch (error) {
    log.warn(
      { component: 'staff-webauthn', err: (error as Error).message },
      'WebAuthn-Zeremonie konnte nicht verbraucht werden',
    );
    throw new HardwareAccessUnavailableError(undefined, { cause: error });
  }
  if (typeof raw !== 'string') {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }
  if (!value || typeof value !== 'object') {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage ist ungültig oder abgelaufen.',
    );
  }
  const ceremony = value as Partial<HardwareCeremony>;
  const rp = relyingParty();
  if (
    ceremony.version !== 1 ||
    ceremony.purpose !== input.purpose ||
    typeof ceremony.challenge !== 'string' ||
    ceremony.origin !== rp.origin ||
    ceremony.rpID !== rp.rpID ||
    ceremony.staffId !== input.staffId ||
    ceremony.tenantId !== input.tenantId ||
    ceremony.targetStaffId !== input.targetStaffId ||
    ceremony.authRevision !== input.authRevision
  ) {
    throw new HardwareAccessVerificationError(
      'Die Schlüssel-Anfrage passt nicht zu diesem Vorgang.',
    );
  }
  return ceremony as HardwareCeremony;
}

export async function beginHardwareLogin(): Promise<{
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  // Der gespeicherte Vertrauensstand wird vor dem Browser-Prompt geprüft. Bei
  // deaktivierter Policy oder fehlendem/veraltetem MDS-Snapshot startet dadurch
  // keine nutzlose Discoverable-Credential-Zeremonie.
  await ensureHardwareMetadataReady();
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60_000,
    userVerification: 'required',
  });
  const ceremonyId = await storeCeremony({ purpose: 'login', challenge: options.challenge });
  return { ceremonyId, options };
}

export async function beginHardwareRegistration(input: {
  staffId: string;
  tenantId: string;
  authRevision: number;
  email: string;
  fullName: string;
  existingCredentials: Array<{ credentialId: string; transports: string[] }>;
}): Promise<{
  ceremonyId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}> {
  await ensureHardwareMetadataReady();
  const { rpID } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: 'Kanzleikonsole',
    rpID,
    userID: new Uint8Array(Buffer.from(input.staffId, 'utf8')),
    userName: input.email,
    userDisplayName: input.fullName,
    timeout: 60_000,
    attestationType: 'direct',
    excludeCredentials: input.existingCredentials.map((credential) => ({
      id: credential.credentialId,
      transports: parseTransports(credential.transports),
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'cross-platform',
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    preferredAuthenticatorType: 'securityKey',
  });
  const ceremonyId = await storeCeremony({
    purpose: 'register',
    challenge: options.challenge,
    staffId: input.staffId,
    tenantId: input.tenantId,
    authRevision: input.authRevision,
  });
  return { ceremonyId, options };
}

export async function beginHardwareModeAssertion(input: {
  purpose: 'mode-enable' | 'mode-disable' | 'admin-recovery';
  staffId: string;
  tenantId: string;
  targetStaffId?: string;
  authRevision?: number;
  credentials: Array<{ credentialId: string; transports: string[] }>;
}): Promise<{
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials: input.credentials.map((credential) => ({
      id: credential.credentialId,
      transports: parseTransports(credential.transports),
    })),
  });
  const ceremonyId = await storeCeremony({
    purpose: input.purpose,
    challenge: options.challenge,
    staffId: input.staffId,
    tenantId: input.tenantId,
    targetStaffId: input.targetStaffId,
    authRevision: input.authRevision,
  });
  return { ceremonyId, options };
}

export function parseTransports(values: readonly string[]): AuthenticatorTransportFuture[] {
  const valid: AuthenticatorTransportFuture[] = [
    'ble',
    'cable',
    'hybrid',
    'internal',
    'nfc',
    'smart-card',
    'usb',
  ];
  const allowed = new Set(valid);
  return Array.from(
    new Set(
      values.filter((value): value is AuthenticatorTransportFuture =>
        allowed.has(value as AuthenticatorTransportFuture),
      ),
    ),
  );
}

export function parseAuthenticationResponse(raw: string): AuthenticationResponseJSON {
  if (!raw || raw.length > RESPONSE_JSON_MAX_CHARS) throw new HardwareAccessVerificationError();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HardwareAccessVerificationError();
  }
  if (!value || typeof value !== 'object') throw new HardwareAccessVerificationError();
  const response = value as Partial<AuthenticationResponseJSON>;
  if (
    typeof response.id !== 'string' ||
    response.id.length < 16 ||
    response.id.length > 2048 ||
    response.type !== 'public-key' ||
    !response.response ||
    typeof response.response.clientDataJSON !== 'string' ||
    typeof response.response.authenticatorData !== 'string' ||
    typeof response.response.signature !== 'string'
  ) {
    throw new HardwareAccessVerificationError();
  }
  return response as AuthenticationResponseJSON;
}

export function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<RegistrationResponseJSON>;
  return (
    typeof response.id === 'string' &&
    response.id.length >= 16 &&
    response.id.length <= 2048 &&
    response.type === 'public-key' &&
    !!response.response &&
    typeof response.response.clientDataJSON === 'string' &&
    typeof response.response.attestationObject === 'string'
  );
}

export function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (!value || typeof value !== 'object') return false;
  try {
    parseAuthenticationResponse(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
