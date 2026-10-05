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
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { readSellerInfoTx } from '@/server/settings/tenant-settings';
import { readBrandingTx } from '@/server/settings/branding';
import { readTaxRegionSettingTx } from '@/server/settings/tax-region';
import { getSmtpStatusTx } from '@/server/settings/smtp';
import { readLegalTx } from '@/server/settings/legal';
import { isPrivacyConfigComplete, readPrivacyConfigTx } from '@/server/privacy/notice';
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
  // P-06: EINE Transaktion statt sieben paralleler (je eigene Pool-Verbindung).
  // Branding kommt aus dem kurzen Prozess-Cache (layout-settings.ts), sonst aus
  // derselben Transaktion.
  const { seller, branding, region, smtp, privacyConfig, legal, counts } = await withTenantContext(
    ctx,
    async (tx) => {
      const seller = await readSellerInfoTx(tx, ctx.tenantId);
      const branding = await readBrandingTx(tx, ctx.tenantId);
      const region = (await readTaxRegionSettingTx(tx, ctx.tenantId)).region;
      const smtp = await getSmtpStatusTx(tx, ctx.tenantId);
      const privacyConfig = await readPrivacyConfigTx(tx, ctx.tenantId);
      const legal = await readLegalTx(tx, ctx.tenantId);
      const contactCount = await tx.clientContact.count({ where: { active: true } });
      const activeClientCount = await tx.client.count({ where: { allowActive: true } });
      // readModules liefert Defaults, wenn nie gespeichert wurde — für die
      // Checkliste zählt die BEWUSSTE Entscheidung, also die Setting-Zeile.
      const modulesRow = await tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: 'modules' } },
        select: { tenantId: true },
      });
      const dismissedValue = await readTenantSettingValue(
        tx,
        ctx.tenantId,
        SETUP_DISMISSED_SETTING_KEY,
      );
      const dismissed = dismissedValue as { dismissed?: unknown } | null | undefined;
      return {
        seller,
        branding,
        region,
        smtp,
        privacyConfig,
        legal,
        counts: {
          contactCount,
          activeClientCount,
          modulesConfigured: modulesRow !== null,
          dismissed: dismissed?.dismissed === true,
        },
      };
    },
  );

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
