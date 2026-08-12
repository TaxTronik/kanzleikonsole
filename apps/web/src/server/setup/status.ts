// =============================================================================
// Setup-Checkliste — fasst zusammen, was für eine produktive Inbetriebnahme
// noch konfiguriert werden muss. Anzeige im Admin-Banner, auf der
// Integrationen-Seite und (kompakt, nur Admins) auf dem Dashboard.
//
// Die reine Entscheidungsfunktion liegt importfrei in checklist.ts
// (Wahrheitstabellen-Test); hier wird nur der IST-Zustand geladen. Alle
// Punkte erledigen sich durch echte Konfiguration von selbst. Ein Admin kann
// die Einführung zusätzlich bewusst ausblenden; dieser Zustand verändert
// niemals die fachlichen Done-Bits der Checkliste.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { readBranding } from '@/server/settings/branding';
import { readTaxRegion } from '@/server/settings/tax-region';
import { getSmtpStatus } from '@/server/settings/smtp';
import { readLegal } from '@/server/settings/legal';
import { isPrivacyConfigComplete, readPrivacyConfig } from '@/server/privacy/notice';
import { buildSetupItems, isSellerSetupComplete, type SetupItem } from './checklist';
import { SETUP_DISMISSED_SETTING_KEY } from './constants';

export type { SetupItem } from './checklist';

export interface SetupStatus {
  items: SetupItem[];
  doneCount: number;
  totalCount: number;
  allDone: boolean;
  dismissed: boolean;
}

export async function getSetupStatus(ctx: TenantContext): Promise<SetupStatus> {
  const [seller, branding, region, smtp, privacyConfig, legal, counts] = await Promise.all([
    readSellerInfo(ctx),
    readBranding(ctx),
    readTaxRegion(ctx),
    getSmtpStatus(ctx),
    readPrivacyConfig(ctx),
    readLegal(ctx),
    withTenantContext(ctx, async (tx) => {
      const [contactCount, activeClientCount, modulesRow, dismissedRow] = await Promise.all([
        tx.clientContact.count({ where: { active: true } }),
        tx.client.count({ where: { allowActive: true } }),
        // readModules liefert Defaults, wenn nie gespeichert wurde — für die
        // Checkliste zählt die BEWUSSTE Entscheidung, also die Setting-Zeile.
        tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId: ctx.tenantId, key: 'modules' } },
          select: { tenantId: true },
        }),
        tx.tenantSetting.findUnique({
          where: {
            tenantId_key: { tenantId: ctx.tenantId, key: SETUP_DISMISSED_SETTING_KEY },
          },
          select: { value: true },
        }),
      ]);
      const dismissedValue = dismissedRow?.value as { dismissed?: unknown } | null | undefined;
      return {
        contactCount,
        activeClientCount,
        modulesConfigured: modulesRow !== null,
        dismissed: dismissedValue?.dismissed === true,
      };
    }),
  ]);

  const items = buildSetupItems({
    brandingComplete: Boolean(branding.displayName) && Boolean(branding.logoDataUrl),
    regionSet: region !== null,
    // E-Mail + Telefon: Pflicht der XRechnung (BG-6); USt-ID ODER Steuernummer
    // bei Standardsatz (BR-S-02) — identisch zum Laufzeit-Check
    // (seller_incomplete, fail-closed), damit die Checkliste nicht „erledigt"
    // meldet, während die E-Rechnungs-Erzeugung noch verweigert.
    sellerComplete: isSellerSetupComplete(seller),
    smtpConfigured: smtp.configured,
    modulesConfigured: counts.modulesConfigured,
    privacyComplete: isPrivacyConfigComplete(privacyConfig) && legal.privacyUrl !== '',
    activeClientCount: counts.activeClientCount,
    contactCount: counts.contactCount,
  });

  const doneCount = items.filter((i) => i.done).length;
  return {
    items,
    doneCount,
    totalCount: items.length,
    allDone: doneCount === items.length,
    dismissed: counts.dismissed,
  };
}
