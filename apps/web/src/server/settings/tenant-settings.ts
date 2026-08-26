// =============================================================================
// Tenant-Settings-Reader/Writer
//
// Tenant-Konfiguration (z. B. Kanzlei-Stammdaten für XRechnung) liegt in der
// Tabelle `tenant_setting` als key/value (JSONB). Dies kapselt typsicheren
// Zugriff.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';

export interface SellerInfo {
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryIso: string; // Default: DE
  vatId: string | null; // USt-ID
  taxNumber: string | null; // Steuernummer
  email: string | null;
  phone: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
}

export const DEFAULT_SELLER_INFO: SellerInfo = {
  name: '',
  street: null,
  postalCode: null,
  city: null,
  countryIso: 'DE',
  vatId: null,
  taxNumber: null,
  email: null,
  phone: null,
  iban: null,
  bic: null,
  bankName: null,
};

const KEY_SELLER = 'invoicing.seller';

/**
 * Liest die Verkäufer-Stammdaten der Kanzlei. Falls nicht gesetzt: Default.
 * Ergänzt um den Tenant-Namen (kommt aus `tenant.name`).
 */
export async function readSellerInfo(ctx: TenantContext): Promise<SellerInfo> {
  return withTenantContext(ctx, async (tx) => {
    const stored = await readTenantSettingValue(tx, ctx.tenantId, KEY_SELLER);
    const tenant = await tx.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { name: true },
    });
    if (stored === undefined) {
      return { ...DEFAULT_SELLER_INFO, name: tenant?.name ?? '' };
    }
    const value = stored as Partial<SellerInfo>;
    return {
      ...DEFAULT_SELLER_INFO,
      ...value,
      name: value.name || tenant?.name || '',
    };
  });
}

export async function writeSellerInfo(ctx: TenantContext, info: SellerInfo): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY_SELLER,
      value: info as object,
      updatedBy: ctx.actorId,
    });
  });
}
