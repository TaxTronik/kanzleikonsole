// =============================================================================
// Mandantenportal-Feature-Flags pro Tenant
//
// Granulare Steuerung dessen, was der MANDANT im Portal sehen / tun darf —
// orthogonal zu den Tenant-weiten Modul-Toggles (modules.ts). Beispiele:
//   - modules.appointments = true   → Kanzleikalender-Termine generell an
//   - portal.appointmentRequests = false → Mandant darf aber KEINE Termin-
//                                          Anfragen über das Portal senden
//   - modules.bwa = true            → BWA-Modul generell an
//   - portal.bwaView = true         → Mandant sieht BWA im Portal
//   - portal.bwaPlanning = false    → Mandant darf aber keine eigene Planung
//                                     anlegen
//
// Liegt in `tenant_setting.portal.features`. Bestehende Flags bleiben per
// Default true (rückwärtskompatibel); neue sicherheitsrelevante Opt-in-Module
// wie `clientInbox` sind bei fehlendem Schlüssel ausdrücklich false.
// =============================================================================

import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';

/** Feature im Mandantenportal deaktiviert — UI-taugliche Meldung (F-03). */
export class PortalFeatureDisabledError extends ActionError {
  constructor(readonly feature: string) {
    super('Diese Funktion ist im Mandantenportal nicht aktiviert.');
    this.name = 'PortalFeatureDisabledError';
  }
}
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { readLayoutSettingsSource, SETTING_KEY_PORTAL_FEATURES } from './layout-settings';

export interface PortalFeatures {
  /** Mandant darf neue Terminanfragen an die Kanzlei senden */
  appointmentRequests: boolean;
  /** Mandant sieht BWA-Auswertungen im Portal */
  bwaView: boolean;
  /** Mandant darf eigene Planrechnungen anlegen (setzt bwaView voraus) */
  bwaPlanning: boolean;
  /** Mandant darf eigene Dokumente hochladen */
  documentUpload: boolean;
  /** Mandant darf den sicheren Nachrichten-/Dateieingang verwenden */
  clientInbox: boolean;
  /** Mandant darf Stammdaten-Änderungen vorschlagen */
  stammdatenSelfService: boolean;
  /** Mandant sieht den Status seiner hinterlegten Unterlagen */
  handoversView: boolean;
}

export const DEFAULT_PORTAL_FEATURES: PortalFeatures = {
  appointmentRequests: true,
  bwaView: true,
  bwaPlanning: true,
  documentUpload: true,
  clientInbox: false,
  stammdatenSelfService: true,
  handoversView: true,
};

const KEY = SETTING_KEY_PORTAL_FEATURES;

function normalize(value: unknown): PortalFeatures {
  const v = (value ?? {}) as Partial<PortalFeatures>;
  return {
    appointmentRequests: v.appointmentRequests !== false,
    bwaView: v.bwaView !== false,
    bwaPlanning: v.bwaPlanning !== false,
    documentUpload: v.documentUpload !== false,
    clientInbox: v.clientInbox === true,
    stammdatenSelfService: v.stammdatenSelfService !== false,
    handoversView: v.handoversView !== false,
  };
}

/** Auswertung des gespeicherten Werts; ohne Eintrag gelten die Defaults. */
export function portalFeaturesFromSetting(value: unknown): PortalFeatures {
  return value === undefined ? DEFAULT_PORTAL_FEATURES : normalize(value);
}

/** Request-scoped über die gemeinsamen Layout-Einstellungen (layout-settings.ts). */
export async function readPortalFeatures(ctx: TenantContext): Promise<PortalFeatures> {
  return portalFeaturesFromSetting((await readLayoutSettingsSource(ctx)).portalFeatures);
}

/** Verwendet einen bereits autorisierten Tenant-Transaktionskontext. */
export async function readPortalFeaturesTx(
  tx: TxClient,
  tenantId: string,
): Promise<PortalFeatures> {
  return portalFeaturesFromSetting(await readTenantSettingValue(tx, tenantId, KEY));
}

export async function writePortalFeatures(ctx: TenantContext, cfg: PortalFeatures): Promise<void> {
  await withTenantContext(ctx, (tx) => writePortalFeaturesTx(tx, ctx.tenantId, ctx.actorId, cfg));
}

export async function writePortalFeaturesTx(
  tx: TxClient,
  tenantId: string,
  updatedBy: string | null,
  cfg: PortalFeatures,
): Promise<void> {
  await writeTenantSettingValue(tx, {
    tenantId,
    key: KEY,
    value: normalize(cfg) as object,
    updatedBy,
  });
}

/**
 * Server-Action-Guard: wirft, wenn das Feature im Portal deaktiviert ist.
 * Wird in den Portal-Server-Actions verwendet, damit ein Mandant auch nicht
 * via direkter API-Call ein deaktiviertes Feature nutzen kann.
 */
export async function assertPortalFeature(
  ctx: TenantContext,
  feature: keyof PortalFeatures,
): Promise<void> {
  const cfg = await readPortalFeatures(ctx);
  if (!cfg[feature]) {
    throw new PortalFeatureDisabledError(feature);
  }
}
