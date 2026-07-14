// =============================================================================
// Tenant-spezifische TSA-Auswahl
//
// Liegt in `tenant_setting` unter dem Key `evidence.tsa`. Speichert nur
// providerId + customUrl — die konkrete URL wird über die Provider-Tabelle
// in @taxtronik/evidence aufgelöst.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';

const KEY = 'evidence.tsa';

export interface TsaConfig {
  providerId: string; // 'freetsa' | 'digicert' | 'dtrust' | 'custom' | …
  customUrl: string; // nur relevant wenn providerId === 'custom'
}

export const DEFAULT_TSA: TsaConfig = {
  providerId: 'globalsign',
  customUrl: '',
};

export async function readTsaConfig(ctx: TenantContext): Promise<TsaConfig> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
    });
    if (!row) return DEFAULT_TSA;
    const v = row.value as Partial<TsaConfig>;
    return {
      providerId: v.providerId ?? DEFAULT_TSA.providerId,
      customUrl: v.customUrl ?? '',
    };
  });
}

export async function writeTsaConfig(ctx: TenantContext, cfg: TsaConfig): Promise<void> {
  const stored: TsaConfig = {
    providerId: cfg.providerId.trim(),
    customUrl: cfg.customUrl.trim(),
  };
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY,
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}
