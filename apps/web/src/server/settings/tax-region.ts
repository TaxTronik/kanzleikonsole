// =============================================================================
// Bundesland-Setting der Kanzlei (für Feiertagskalender)
//
// Gespeichert in `tenant_setting` unter Key `tax_region`. Wird für die
// Werktagsverschiebung in der Steuertermin-Engine verwendet.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import type { GermanRegion } from '@taxtronik/tax';

const KEY_TAX_REGION = 'tax_region';

export async function readTaxRegion(ctx: TenantContext): Promise<GermanRegion | null> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY_TAX_REGION } },
    });
    if (!row) return null;
    const v = row.value as { region?: string };
    return (v.region as GermanRegion) ?? null;
  });
}

export async function writeTaxRegion(
  ctx: TenantContext,
  region: GermanRegion | null,
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY_TAX_REGION } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY_TAX_REGION,
        value: { region },
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: { region },
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}
