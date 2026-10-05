// =============================================================================
// Daten der geschützten Staff- und Portal-Layouts in EINER Transaktion (P-06).
//
// Vorher: Staff-Layout 4 parallele Settings-Transaktionen plus eine für die
// Glocke, Portal-Layout 6. Jetzt eine Transaktion je Layout; die Einstellungen
// landen dabei im Request-Scope (layout-settings.ts), sodass Modul-Gates und
// Settings-Reads der Seite keine weitere Transaktion öffnen.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import type { AccessibleDisplayOptions } from '@/lib/accessible-display-options';
import {
  findPortalProfilesForContactTx,
  type PortalProfileOption,
} from '@/server/auth/portal-profiles';
import {
  readUnreadNotificationSummaryTx,
  type UnreadNotificationSummary,
} from '@/server/notifications/unread-summary';
import { accessibleDisplayFromAccount } from './accessible-display';
import { brandingFromSource, type BrandingInfo } from './branding';
import { readLayoutSettingsSourceWith, type LayoutSettingsSource } from './layout-settings';
import { moduleConfigFromSetting, type ModuleConfig } from './modules';
import { portalFeaturesFromSetting, type PortalFeatures } from './portal-features';

export interface LayoutSettings {
  branding: BrandingInfo;
  modules: ModuleConfig;
  portalFeatures: PortalFeatures;
  accessibleDisplay: boolean;
  accessibleDisplayOptions: AccessibleDisplayOptions;
}

export function layoutSettingsFromSource(source: LayoutSettingsSource): LayoutSettings {
  const display = accessibleDisplayFromAccount(source.account);
  return {
    branding: brandingFromSource(source.branding),
    modules: moduleConfigFromSetting(source.modules),
    portalFeatures: portalFeaturesFromSetting(source.portalFeatures),
    accessibleDisplay: display.enabled,
    accessibleDisplayOptions: display.options,
  };
}

export interface StaffLayoutData extends LayoutSettings {
  notifications: UnreadNotificationSummary;
}

export async function readStaffLayoutData(
  ctx: TenantContext & { actorId: string; actorType: 'STAFF' },
): Promise<StaffLayoutData> {
  const { source, extra } = await readLayoutSettingsSourceWith(ctx, (tx) =>
    readUnreadNotificationSummaryTx(tx, ctx.actorId),
  );
  return { ...layoutSettingsFromSource(source), notifications: extra };
}

export interface PortalLayoutData extends LayoutSettings {
  clientName: string | null;
  profiles: PortalProfileOption[];
}

export async function readPortalLayoutData(
  ctx: TenantContext & { actorId: string; actorType: 'CLIENT_CONTACT' },
  input: { clientId: string; email: string },
): Promise<PortalLayoutData> {
  const { source, extra } = await readLayoutSettingsSourceWith(ctx, async (tx) => {
    const client = await tx.client.findUnique({
      where: { id: input.clientId },
      select: { name: true },
    });
    const profiles = await findPortalProfilesForContactTx(tx, {
      tenantId: ctx.tenantId,
      contactId: ctx.actorId,
      email: input.email,
    });
    return { clientName: client?.name ?? null, profiles };
  });
  return { ...layoutSettingsFromSource(source), ...extra };
}
