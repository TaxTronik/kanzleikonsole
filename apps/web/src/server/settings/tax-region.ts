// =============================================================================
// Bundesland-Setting der Kanzlei (für Feiertagskalender)
//
// Gespeichert in `tenant_setting` unter Key `tax_region`. Wird für die
// Werktagsverschiebung in der Steuertermin-Engine verwendet.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { lockTaxScheduleTx, type GermanRegion } from '@taxtronik/tax';

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
  return withTenantContext(ctx, (tx) => readTaxRegionSettingTx(tx, ctx.tenantId));
}

/** Verwendet eine bereits geöffnete Tenant-Transaktion (kein zweiter Pool-Slot). */
export async function readTaxRegionSettingTx(
  tx: TxClient,
  tenantId: string,
): Promise<TaxRegionSetting> {
  const value = await readTenantSettingValue(tx, tenantId, KEY_TAX_REGION);
  const v = (value as { region?: string; assumptionHoliday?: boolean } | null) ?? null;
  return {
    region: (v?.region as GermanRegion) ?? null,
    assumptionHoliday: v?.assumptionHoliday !== false,
  };
}

export async function writeTaxRegion(
  ctx: TenantContext,
  region: GermanRegion | null,
  assumptionHoliday = true,
): Promise<void> {
  await withTenantContext(ctx, (tx) => writeTaxRegionTx(tx, ctx, region, assumptionHoliday));
}

/** AUDIT-HASH-CHAIN-001: use the caller transaction to commit setting and audit together. */
export async function writeTaxRegionTx(
  tx: TxClient,
  ctx: TenantContext,
  region: GermanRegion | null,
  assumptionHoliday = true,
): Promise<void> {
  const value = { region, assumptionHoliday };
  // Same candidate-generation boundary as schedule edits. The existing UI
  // policy deliberately retains already materialized deadlines unchanged.
  await lockTaxScheduleTx(tx, ctx.tenantId);
  await writeTenantSettingValue(tx, {
    tenantId: ctx.tenantId,
    key: KEY_TAX_REGION,
    value,
    updatedBy: ctx.actorId,
  });
}
