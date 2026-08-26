// =============================================================================
// Bundesland-Setting der Kanzlei (für Feiertagskalender)
//
// Gespeichert in `tenant_setting` unter Key `tax_region`. Wird für die
// Werktagsverschiebung in der Steuertermin-Engine verwendet.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import type { GermanRegion } from '@taxtronik/tax';

const KEY_TAX_REGION = 'tax_region';

export interface TaxRegionSetting {
  region: GermanRegion | null;
  /** Begeht der Kanzleisitz Mariä Himmelfahrt (15.08.) als Feiertag? Nur in
   *  Bayern relevant (gemeindeabhängig, Art. 1 Abs. 1 BayFTG). Default true. */
  assumptionHoliday: boolean;
}

export async function readTaxRegion(ctx: TenantContext): Promise<GermanRegion | null> {
  return (await readTaxRegionSetting(ctx)).region;
}

export async function readTaxRegionSetting(ctx: TenantContext): Promise<TaxRegionSetting> {
  return withTenantContext(ctx, async (tx) => {
    const value = await readTenantSettingValue(tx, ctx.tenantId, KEY_TAX_REGION);
    const v = (value as { region?: string; assumptionHoliday?: boolean } | null) ?? null;
    return {
      region: (v?.region as GermanRegion) ?? null,
      assumptionHoliday: v?.assumptionHoliday !== false,
    };
  });
}

export async function writeTaxRegion(
  ctx: TenantContext,
  region: GermanRegion | null,
  assumptionHoliday = true,
): Promise<void> {
  const value = { region, assumptionHoliday };
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY_TAX_REGION,
      value,
      updatedBy: ctx.actorId,
    });
  });
}
