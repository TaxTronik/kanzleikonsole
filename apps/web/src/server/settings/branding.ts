// =============================================================================
// Tenant-Branding
//
// Logo (Text), Akzent-Farbe (Hex), Sub-Brand-Name (z. B. "Steuerkanzlei Müller").
// Liegt in `tenant_setting.branding`. Wird in den Layouts gerendert (Sidebar
// statt "taxtronik" zeigt Sub-Brand, Akzent-Farbe als CSS-Variable).
// =============================================================================

import { cache } from 'react';
import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { prismaOwner } from '@/server/db/prisma-owner';

export interface BrandingInfo {
  // Anzeige-Name in der Sidebar oben (überschreibt "taxtronik")
  displayName: string;
  // Hex-Farbe für CSS-Variable --brand-accent (z. B. "#2563eb")
  accentColor: string;
  // Optional: Untertitel-Text in der Sidebar
  subtitle: string | null;
  // Logo als Data-URL (PNG/JPG/WebP, base64-encoded). Inline gespeichert weil
  // typischerweise <50 KB; vermeidet Storage-Komplexität für ein einzelnes
  // Bild pro Tenant. Wenn null: Text-Anzeige (displayName) wird verwendet.
  logoDataUrl: string | null;
  // Optional: Dark-Mode-Variante des Logos (Data-URL, gleiche Formate). Wenn
  // gesetzt, wird im Dark Theme diese Variante gerendert — sonst ist ein
  // dunkles Logo auf dem dunklen Sidebar-Hintergrund unlesbar. Bleibt sie null,
  // gilt logoDataUrl in beiden Themes (bisheriges Verhalten).
  logoDataUrlDark: string | null;
}

export const DEFAULT_BRANDING: BrandingInfo = {
  displayName: 'taxtronik',
  accentColor: '#2563eb', // brand-600
  subtitle: null,
  logoDataUrl: null,
  logoDataUrlDark: null,
};

const KEY_BRANDING = 'branding';

// Wird im Layout gerendert (Sidebar-Logo/Akzentfarbe). cache() request-scoped
// auf Primitiven (s. modules.ts — Objekt-ctx würde per Referenz nicht greifen).
const readBrandingCached = cache(
  (
    tenantId: string,
    actorId: TenantContext['actorId'],
    actorType: TenantContext['actorType'],
  ): Promise<BrandingInfo> => readBrandingByCtx({ tenantId, actorId, actorType }),
);

function readBrandingByCtx(ctx: TenantContext): Promise<BrandingInfo> {
  return withTenantContext(ctx, async (tx) => {
    const value = await readTenantSettingValue(tx, ctx.tenantId, KEY_BRANDING);
    if (value === undefined) {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true },
      });
      return { ...DEFAULT_BRANDING, displayName: tenant?.name ?? DEFAULT_BRANDING.displayName };
    }
    const branding = value as Partial<BrandingInfo>;
    return {
      ...DEFAULT_BRANDING,
      ...branding,
    };
  });
}

export function readBranding(ctx: TenantContext): Promise<BrandingInfo> {
  return readBrandingCached(ctx.tenantId, ctx.actorId, ctx.actorType);
}

/**
 * Public-safe Reader: resolved den Tenant über den Slug. Wird auf Login-Seiten
 * verwendet, bevor eine Session existiert (Staff- und Portal-Login zeigen das
 * Kanzlei-Branding).
 *
 * Bewusst über prismaOwner (kein RLS) — Tenant-Settings sind pro-Tenant strikt
 * isoliert, weil wir explizit nach (tenantSlug, key='branding') filtern. Keine
 * sensiblen Daten — Anzeige-Name, Akzentfarbe und Logos, die ohnehin auf jeder
 * Seite des Tenants öffentlich sichtbar sind (Muster: readLegalForSlug).
 */
export async function readBrandingForSlug(slug: string): Promise<BrandingInfo> {
  const tenant = await prismaOwner.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!tenant) return DEFAULT_BRANDING;
  const value = await readTenantSettingValue(prismaOwner, tenant.id, KEY_BRANDING);
  if (value === undefined) {
    return { ...DEFAULT_BRANDING, displayName: tenant.name };
  }
  const branding = value as Partial<BrandingInfo>;
  return {
    ...DEFAULT_BRANDING,
    ...branding,
  };
}

export async function writeBranding(ctx: TenantContext, info: BrandingInfo): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY_BRANDING,
      value: info as object,
      updatedBy: ctx.actorId,
    });
  });
}
