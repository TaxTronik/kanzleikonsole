// =============================================================================
// Setup-Checkliste — fasst zusammen, was für eine produktive Inbetriebnahme
// noch konfiguriert werden muss. Anzeige im Admin-Banner, auf der
// Integrationen-Seite und (kompakt, nur Admins) auf dem Dashboard.
//
// Die reine Entscheidungsfunktion liegt importfrei in checklist.ts
// (Wahrheitstabellen-Test); hier wird nur der IST-Zustand geladen. Alle
// Punkte erledigen sich durch echte Konfiguration von selbst — es gibt
// bewusst keinen „Ausblenden"-Schalter und keinen gespeicherten
// Tutorial-Fortschritt, der lügen könnte.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { readBranding } from '@/server/settings/branding';
import { readTaxRegion } from '@/server/settings/tax-region';
import { getSmtpStatus } from '@/server/settings/smtp';
import { buildSetupItems, type SetupItem } from './checklist';

export type { SetupItem } from './checklist';

export interface SetupStatus {
  items: SetupItem[];
  doneCount: number;
  totalCount: number;
  allDone: boolean;
}

export async function getSetupStatus(ctx: TenantContext): Promise<SetupStatus> {
  const [seller, branding, region, smtp, counts] = await Promise.all([
    readSellerInfo(ctx),
    readBranding(ctx),
    readTaxRegion(ctx),
    getSmtpStatus(ctx),
    withTenantContext(ctx, async (tx) => {
      const [contactCount, activeClientCount, modulesRow] = await Promise.all([
        tx.clientContact.count({ where: { active: true } }),
        tx.client.count({ where: { allowActive: true } }),
        // readModules liefert Defaults, wenn nie gespeichert wurde — für die
        // Checkliste zählt die BEWUSSTE Entscheidung, also die Setting-Zeile.
        tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId: ctx.tenantId, key: 'modules' } },
          select: { tenantId: true },
        }),
      ]);
      return { contactCount, activeClientCount, modulesConfigured: modulesRow !== null };
    }),
  ]);

  const items = buildSetupItems({
    brandingComplete: Boolean(branding.displayName) && Boolean(branding.logoDataUrl),
    regionSet: region !== null,
    // E-Mail + Telefon: Pflicht der XRechnung (BG-6); USt-ID ODER Steuernummer
    // bei Standardsatz (BR-S-02) — identisch zum Laufzeit-Check
    // (seller_incomplete, fail-closed), damit die Checkliste nicht „erledigt"
    // meldet, während die E-Rechnungs-Erzeugung noch verweigert.
    sellerComplete: Boolean(
      seller.name && seller.street && seller.postalCode && seller.city &&
      (seller.vatId || seller.taxNumber) && seller.email && seller.phone,
    ),
    smtpConfigured: smtp.configured,
    modulesConfigured: counts.modulesConfigured,
    activeClientCount: counts.activeClientCount,
    contactCount: counts.contactCount,
  });

  const doneCount = items.filter((i) => i.done).length;
  return {
    items,
    doneCount,
    totalCount: items.length,
    allDone: doneCount === items.length,
  };
}
