// =============================================================================
// Briefkopf-Konfiguration für App-generierte Rechnungs-PDFs
//
// Liegt in `tenant_setting` unter `branding.letterhead`. Wird vom
// ZUGFeRD-Rechnungsgenerator eingebunden. Bereits archivierte Rechnungen und
// extern hochgeladene/signierte PDFs bleiben unverändert.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';

const KEY = 'branding.letterhead';

export interface LetterheadConfig {
  /** Kanzlei-Name (große Headline, oben rechts) */
  organisationName: string;
  /** Mehrzeilige Adresse (Markdown ohne Header — wird so abgedruckt) */
  addressLines: string;
  /** Kontakt-Zeile (Telefon, Fax, E-Mail) */
  contactLine: string;
  /** Steuerberaterkammer / Registriernummer / Sitz — Fußnote */
  footnote: string;
}

export const DEFAULT_LETTERHEAD: LetterheadConfig = {
  organisationName: '',
  addressLines: '',
  contactLine: '',
  footnote: '',
};

export async function readLetterhead(ctx: TenantContext): Promise<LetterheadConfig> {
  return withTenantContext(ctx, async (tx) => {
    const value = await readTenantSettingValue(tx, ctx.tenantId, KEY);
    if (value === undefined) return DEFAULT_LETTERHEAD;
    const v = value as Partial<LetterheadConfig>;
    return {
      organisationName: v.organisationName ?? '',
      addressLines: v.addressLines ?? '',
      contactLine: v.contactLine ?? '',
      footnote: v.footnote ?? '',
    };
  });
}

export async function writeLetterhead(ctx: TenantContext, cfg: LetterheadConfig): Promise<void> {
  const stored: LetterheadConfig = {
    organisationName: cfg.organisationName.trim(),
    addressLines: cfg.addressLines.trim(),
    contactLine: cfg.contactLine.trim(),
    footnote: cfg.footnote.trim(),
  };
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY,
      value: stored as object,
      updatedBy: ctx.actorId,
    });
  });
}
