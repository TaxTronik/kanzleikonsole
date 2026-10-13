// =============================================================================
// Datenschutzhinweise (Teil A) — versionierter Standardtext + Kanzlei-Config.
//
// Welle 15 (Folgepunkt P-11): Standardtext, Version, Config-Typ, Lesen und
// Rendern liegen unverändert in @taxtronik/db/privacy-notice, damit der Worker
// (DSGVO-Auskunft) denselben Text rendert. Dieses Modul behält den bisherigen
// Importpfad der Web-App und das Schreiben der Kanzlei-Angaben.
//
// Beim Erteilen wird der GERENDERTE Volltext als notice_snapshot eingefroren —
// spätere Config-/Anbieteränderungen berühren alte Einwilligungen nicht.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  PRIVACY_NOTICE_SETTING_KEY,
  readPrivacyConfigTx,
  type PrivacyConfig,
} from '@taxtronik/db/privacy-notice';
import { lockConsentCatalogTx } from './catalog-lock';

export {
  DEFAULT_PRIVACY_CONFIG,
  isPrivacyConfigComplete,
  PRIVACY_NOTICE_VERSION,
  readPrivacyConfigTx,
  renderPrivacyNotice,
  type NoticeRenderInput,
  type PrivacyConfig,
} from '@taxtronik/db/privacy-notice';

export async function readPrivacyConfig(ctx: TenantContext): Promise<PrivacyConfig> {
  return withTenantContext(ctx, (tx) => readPrivacyConfigTx(tx, ctx.tenantId));
}

export async function writePrivacyConfig(ctx: TenantContext, cfg: PrivacyConfig): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await lockConsentCatalogTx(tx, ctx.tenantId);
    await writePrivacyConfigTx(tx, ctx.tenantId, ctx.actorId ?? null, cfg);
  });
}

/** Schreibt die Kanzlei-Angaben innerhalb einer bereits laufenden Tenant-Tx. */
export async function writePrivacyConfigTx(
  tx: TxClient,
  tenantId: string,
  updatedBy: string | null,
  cfg: PrivacyConfig,
): Promise<void> {
  await writeTenantSettingValue(tx, {
    tenantId,
    key: PRIVACY_NOTICE_SETTING_KEY,
    value: cfg as object,
    updatedBy,
  });
}
