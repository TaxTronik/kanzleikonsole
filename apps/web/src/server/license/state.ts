// =============================================================================
// Lizenz-Status-Cache + Boot-Check
//
// Beim ersten Aufruf wird der Lizenz-Token verifiziert und das Ergebnis
// in einem Modul-lokalen Cache gehalten. Nach Ablauf des Cache (60 min)
// wird neu geprüft — relevant für Lizenzen mit kurzer Restlaufzeit.
//
// Zusätzlich (N3): Tenant-Bindung. Ein durchgesickerter Lizenz-Token für
// Kanzlei A darf nicht auf einer Installation für Kanzlei B funktionieren.
// Der `sub`-Claim muss zum Slug des primären Tenants dieser Installation
// passen.
// =============================================================================

import { verifyLicense, type LicenseInfo } from './verify';
import { prismaOwner } from '@/server/db/prisma-owner';

let cached: { info: LicenseInfo; until: number } | null = null;
const TTL_MS = 60 * 60 * 1000;

async function getInstallationTenantSlug(): Promise<string | null> {
  try {
    const first = await prismaOwner.tenant.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { slug: true },
    });
    return first?.slug ?? null;
  } catch {
    // DB nicht erreichbar — Lizenz-Check schlägt nicht fehl, sondern Bindung
    // wird übersprungen. Der Boot-Check loggt das.
    return null;
  }
}

export async function getLicenseInfo(): Promise<LicenseInfo> {
  if (cached && cached.until > Date.now()) return cached.info;

  const token = process.env['LICENSE_KEY'];
  const publicKey = process.env['LICENSE_PUBLIC_KEY'];
  const info = await verifyLicense(token, publicKey);

  // N3: Tenant-Bindung erzwingen. Wenn die Lizenz einen `sub`-Claim hat,
  // muss er zum Slug des primären Tenants passen — sonst INVALID.
  if (info.status === 'VALID' && info.tenantSlug) {
    const installationSlug = await getInstallationTenantSlug();
    if (installationSlug && installationSlug !== info.tenantSlug) {
      const rebound: LicenseInfo = {
        ...info,
        status: 'INVALID',
        message: 'Lizenz gehört zu einer anderen Installation.',
        errorDetail: `sub=${info.tenantSlug}, install=${installationSlug}`,
      };
      cached = { info: rebound, until: Date.now() + TTL_MS };
      return rebound;
    }
  }

  cached = { info, until: Date.now() + TTL_MS };
  return info;
}

/** Cache invalidieren — z. B. nach Update des LICENSE_KEY zur Laufzeit. */
export function invalidateLicenseCache(): void {
  cached = null;
}
