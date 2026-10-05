// =============================================================================
// Tenant-Branding
//
// Logo (Text), Akzent-Farbe (Hex), Sub-Brand-Name (z. B. "Steuerkanzlei Müller").
// Liegt in `tenant_setting.branding`. Wird in den Layouts gerendert (Sidebar
// statt "taxtronik" zeigt Sub-Brand, Akzent-Farbe als CSS-Variable).
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { prismaOwner } from '@/server/db/prisma-owner';
import {
  invalidateBrandingCache,
  readBrandingSourceTx,
  readLayoutSettingsSource,
  SETTING_KEY_BRANDING,
  type BrandingSource,
} from './layout-settings';

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

const KEY_BRANDING = SETTING_KEY_BRANDING;

/** Auswertung des gespeicherten Brandings; ohne Eintrag gilt der Tenant-Name. */
export function brandingFromSource(source: BrandingSource): BrandingInfo {
  if (source.stored === undefined) {
    return { ...DEFAULT_BRANDING, displayName: source.tenantName ?? DEFAULT_BRANDING.displayName };
  }
  const branding = source.stored as Partial<BrandingInfo>;
  return {
    ...DEFAULT_BRANDING,
    ...branding,
  };
}

// Wird im Layout gerendert (Sidebar-Logo/Akzentfarbe). Request-scoped über die
// gemeinsamen Layout-Einstellungen, prozessweit kurz gecacht (layout-settings.ts).
export async function readBranding(ctx: TenantContext): Promise<BrandingInfo> {
  return brandingFromSource((await readLayoutSettingsSource(ctx)).branding);
}

/** Verwendet eine bereits geöffnete Tenant-Transaktion (kein zweiter Pool-Slot). */
export async function readBrandingTx(tx: TxClient, tenantId: string): Promise<BrandingInfo> {
  return brandingFromSource(await readBrandingSourceTx(tx, tenantId));
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
  return brandingFromSource({ stored: value, tenantName: tenant.name });
}

export async function writeBranding(ctx: TenantContext, info: BrandingInfo): Promise<void> {
  await withTenantContext(ctx, (tx) => writeBrandingTx(tx, ctx, info));
  invalidateBrandingCache(ctx.tenantId);
}

/**
 * AUDIT-HASH-CHAIN-001: use the caller transaction to commit setting and audit together.
 * Der Aufrufer ruft nach dem Commit zusätzlich `invalidateBrandingCache` auf; sonst
 * kann eine parallele Anfrage den alten Stand bis zum TTL erneut cachen.
 */
export async function writeBrandingTx(
  tx: TxClient,
  ctx: TenantContext,
  info: BrandingInfo,
): Promise<void> {
  invalidateBrandingCache(ctx.tenantId);
  await writeTenantSettingValue(tx, {
    tenantId: ctx.tenantId,
    key: KEY_BRANDING,
    value: info as object,
    updatedBy: ctx.actorId,
  });
}

export { invalidateBrandingCache };
