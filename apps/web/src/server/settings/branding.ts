// =============================================================================
// Tenant-Branding
//
// Logo (Text), Akzent-Farbe (Hex), Sub-Brand-Name (z. B. "Steuerkanzlei Müller").
// Liegt in `tenant_setting.branding`. Wird in den Layouts gerendert (Sidebar
// statt "taxtronik" zeigt Sub-Brand, Akzent-Farbe als CSS-Variable).
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';

export interface BrandingInfo {
  // Anzeige-Name in der Sidebar oben (überschreibt "taxtronik")
  displayName: string;
  // Hex-Farbe für CSS-Variable --brand-accent (z. B. "#2563eb")
  accentColor: string;
  // Optional: Untertitel-Text in der Sidebar
  subtitle: string | null;
  // Logo als Data-URL (PNG/JPG/SVG, base64-encoded). Inline gespeichert weil
  // typischerweise <50 KB; vermeidet Storage-Komplexität für ein einzelnes
  // Bild pro Tenant. Wenn null: Text-Anzeige (displayName) wird verwendet.
  logoDataUrl: string | null;
}

export const DEFAULT_BRANDING: BrandingInfo = {
  displayName: 'taxtronik',
  accentColor: '#2563eb', // brand-600
  subtitle: null,
  logoDataUrl: null,
};

const KEY_BRANDING = 'branding';

export async function readBranding(ctx: TenantContext): Promise<BrandingInfo> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY_BRANDING } },
    });
    if (!row) {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true },
      });
      return { ...DEFAULT_BRANDING, displayName: tenant?.name ?? DEFAULT_BRANDING.displayName };
    }
    const value = row.value as Partial<BrandingInfo>;
    return {
      ...DEFAULT_BRANDING,
      ...value,
    };
  });
}

export async function writeBranding(ctx: TenantContext, info: BrandingInfo): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY_BRANDING } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY_BRANDING,
        value: info as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: info as object,
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}
