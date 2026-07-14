// =============================================================================
// Lizenzschlüssel-Verifikation (signiertes JWT, EdDSA / Ed25519)
//
// Für On-Premise-Deploys signiert ein zentraler Lizenz-Server (oder die
// Anbieter-Holding) ein JWT mit Ed25519-Privatkey. Die App kennt den
// öffentlichen Schlüssel und verifiziert beim Start.
//
// Token-Claims (eigene + Standard):
//   - kanzleiName  (string)  Name der Kanzlei für Anzeige
//   - plan         (string)  z. B. 'TRIAL' / 'STANDARD' / 'ENTERPRISE'
//   - maxStaff     (number?) optional Limit
//   - maxClients   (number?) optional Limit
//   - exp          (number)  Standard-JWT-Ablauf in Sekunden seit Epoch
//   - iat          (number)  Issued-At
//   - sub          (string)  Tenant-Slug der lizenzierten Kanzlei
//
// Verhalten:
//   - Kein Lizenz-Key gesetzt   → status='UNCONFIGURED'  (App läuft, Hinweis)
//   - Public-Key fehlt          → status='UNCONFIGURED'
//   - Token ungültig/manipuliert → status='INVALID'
//   - Token abgelaufen           → status='EXPIRED'      (App läuft weiter, Banner)
//   - Token gültig               → status='VALID'
//
// Bewusst KEIN Hard-Stop bei abgelaufener Lizenz — On-Premise-Software die sich
// selbst abschaltet ist ein Albtraum für Kunden. Stattdessen prominenter Banner
// und Anzeige im Admin-Bereich.
// =============================================================================

import { jwtVerify, importSPKI, type JWTPayload } from 'jose';
import { fmtDateShort } from '@/lib/fmt';

export type LicenseStatus = 'VALID' | 'EXPIRED' | 'INVALID' | 'UNCONFIGURED';

export interface LicenseInfo {
  status: LicenseStatus;
  /** Anzeigetext für UIs (immer gesetzt). */
  message: string;
  kanzleiName?: string;
  plan?: string;
  validUntil?: Date;
  daysRemaining?: number;
  maxStaff?: number;
  maxClients?: number;
  tenantSlug?: string;
  /** Bei INVALID: Detail für Logs. Nicht im UI zeigen. */
  errorDetail?: string;
}

interface LicenseClaims extends JWTPayload {
  kanzleiName?: unknown;
  plan?: unknown;
  maxStaff?: unknown;
  maxClients?: unknown;
}

const ALG = 'EdDSA';

/**
 * Verifiziert einen Lizenz-Token gegen den konfigurierten Public-Key.
 * Liest LICENSE_KEY und LICENSE_PUBLIC_KEY (PEM-formatiert, SPKI) aus
 * den übergebenen Werten — der Aufrufer holt sie aus `process.env`.
 */
export async function verifyLicense(
  token: string | undefined,
  publicKeyPem: string | undefined,
): Promise<LicenseInfo> {
  if (!token || token.trim() === '') {
    return { status: 'UNCONFIGURED', message: 'Keine Lizenz konfiguriert.' };
  }
  if (!publicKeyPem || publicKeyPem.trim() === '') {
    return { status: 'UNCONFIGURED', message: 'Lizenz-Public-Key fehlt.' };
  }

  let publicKey;
  try {
    publicKey = await importSPKI(publicKeyPem.trim(), ALG);
  } catch (e) {
    return {
      status: 'UNCONFIGURED',
      message: 'Lizenz-Public-Key konnte nicht gelesen werden.',
      errorDetail: (e as Error).message,
    };
  }

  let claims: LicenseClaims;
  try {
    const { payload } = await jwtVerify<LicenseClaims>(token, publicKey, {
      algorithms: [ALG],
    });
    claims = payload;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'ERR_JWT_EXPIRED') {
      // L-2: bei ERR_JWT_EXPIRED ist die Signatur valide, nur das exp ist
      // überschritten. Wir re-verifizieren mit `clockTolerance: Infinity`,
      // damit der Decode strikt durch jose läuft und nicht durch ein
      // manuelles base64-Decode-Bypass (Annahme über jose-Fehler-Reihenfolge
      // wäre sonst fragil bei SDK-Upgrades).
      return await decodeExpiredToken(token, publicKey);
    }
    return {
      status: 'INVALID',
      message: 'Lizenzschlüssel ist ungültig oder manipuliert.',
      errorDetail: err.message,
    };
  }

  const validUntil = claims.exp ? new Date(claims.exp * 1000) : undefined;
  const daysRemaining = validUntil
    ? Math.ceil((validUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : undefined;

  return {
    status: 'VALID',
    message: 'Lizenz aktiv.',
    kanzleiName: typeof claims.kanzleiName === 'string' ? claims.kanzleiName : undefined,
    plan: typeof claims.plan === 'string' ? claims.plan : 'STANDARD',
    validUntil,
    daysRemaining,
    maxStaff: typeof claims.maxStaff === 'number' ? claims.maxStaff : undefined,
    maxClients: typeof claims.maxClients === 'number' ? claims.maxClients : undefined,
    tenantSlug: typeof claims.sub === 'string' ? claims.sub : undefined,
  };
}

async function decodeExpiredToken(
  token: string,
  publicKey: Awaited<ReturnType<typeof importSPKI>>,
): Promise<LicenseInfo> {
  // L-2: explizite Signatur-Verifikation, nur exp-Check übersprungen via
  // hoher clockTolerance. Manueller base64-Decode ohne Signatur-Prüfung
  // wäre fragil: bei einer SDK-Migration könnte ein anderer jose-Fehler-
  // Code zu ERR_JWT_EXPIRED werden und ungültige Tokens als „nur abgelaufen"
  // anzeigen. Mit jwtVerify + Toleranz ist garantiert: nur valide Signatur
  // landet hier.
  let claims: LicenseClaims;
  try {
    const { payload } = await jwtVerify<LicenseClaims>(token, publicKey, {
      algorithms: [ALG],
      // 100 Jahre = lange genug, jeden realistisch abgelaufenen Token zu akzeptieren.
      clockTolerance: 100 * 365 * 24 * 60 * 60,
    });
    claims = payload;
  } catch (e) {
    return {
      status: 'INVALID',
      message: 'Lizenzschlüssel ist ungültig.',
      errorDetail: (e as Error).message,
    };
  }

  const validUntil = claims.exp ? new Date(claims.exp * 1000) : undefined;
  const daysRemaining = validUntil
    ? Math.ceil((validUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : undefined;
  return {
    status: 'EXPIRED',
    message: validUntil ? `Lizenz seit ${dateOnly(validUntil)} abgelaufen.` : 'Lizenz abgelaufen.',
    kanzleiName: typeof claims.kanzleiName === 'string' ? claims.kanzleiName : undefined,
    plan: typeof claims.plan === 'string' ? claims.plan : undefined,
    validUntil,
    daysRemaining,
    tenantSlug: typeof claims.sub === 'string' ? claims.sub : undefined,
  };
}

function dateOnly(d: Date): string {
  return fmtDateShort(d);
}
