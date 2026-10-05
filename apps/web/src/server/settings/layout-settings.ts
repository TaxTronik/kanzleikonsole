// =============================================================================
// Gemeinsamer Lesepfad für die Einstellungen, die jede Seite über das Layout
// braucht: Branding, Module, Portal-Features und die persönliche Darstellung.
//
// P-06: Vorher öffneten Staff-Layout (4 + Glocke), Portal-Layout (6) und jede
// Seite mit Modul-Gate eigene Transaktionen mit je eigener Pool-Verbindung.
// Jetzt liest EINE Transaktion alle Tenant-Schlüssel mit EINER Abfrage plus das
// Profil des Akteurs. Das Ergebnis liegt request-scoped im React-cache(), sodass
// Layout und Seite (die Next parallel rendert) dieselbe Transaktion teilen.
//
// Prozessweit gecacht wird nur das Branding (Anzeige-Name, Akzentfarbe, Logos,
// bis 2 × 320 KB): veraltete Werte sind dort rein kosmetisch und laufen nach
// BRANDING_CACHE_TTL_MS ab; Schreibpfade verwerfen den Eintrag sofort. Module,
// Portal-Features und die persönliche Darstellung sind Freigaben bzw. eine
// Nutzerentscheidung und werden deshalb in jeder Anfrage frisch gelesen.
//
// Dieses Modul liefert nur Rohwerte. Die fachliche Auswertung bleibt in
// branding.ts, modules.ts, portal-features.ts und accessible-display.ts.
// =============================================================================

import { cache } from 'react';
import type { ActorType, TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import { readTenantSettingValue, readTenantSettingValues } from '@taxtronik/db/tenant-settings';
import { DISPLAY_OPTIONS_SELECT } from '@/lib/accessible-display-options';

export const SETTING_KEY_BRANDING = 'branding';
export const SETTING_KEY_MODULES = 'modules';
export const SETTING_KEY_PORTAL_FEATURES = 'portal.features';

/** Gespeichertes Branding plus Tenant-Name als Fallback für den Anzeige-Namen. */
export interface BrandingSource {
  stored: unknown;
  tenantName: string | null;
}

export interface AccountDisplaySource {
  accessibleDisplay?: unknown;
  accessibleDisplayFontSize?: unknown;
  accessibleDisplaySpacing?: unknown;
  accessibleDisplayContrast?: unknown;
  accessibleDisplayReduceMotion?: unknown;
}

export interface LayoutSettingsSource {
  branding: BrandingSource;
  modules: unknown;
  portalFeatures: unknown;
  /** null: kein Staff-/Kontakt-Akteur oder kein aktives Profil. */
  account: AccountDisplaySource | null;
}

// ---------------------------------------------------------------------------
// Prozessweiter Branding-Cache
// ---------------------------------------------------------------------------

export const BRANDING_CACHE_TTL_MS = 60_000;
const brandingCache = new Map<string, { source: BrandingSource; expiresAt: number }>();

function cachedBrandingSource(tenantId: string, now: number): BrandingSource | undefined {
  const hit = brandingCache.get(tenantId);
  if (!hit) return undefined;
  if (hit.expiresAt > now) return hit.source;
  brandingCache.delete(tenantId);
  return undefined;
}

function rememberBrandingSource(tenantId: string, source: BrandingSource, now: number): void {
  brandingCache.set(tenantId, { source, expiresAt: now + BRANDING_CACHE_TTL_MS });
}

/** Nach jedem Branding-Schreibvorgang aufrufen (vor und nach dem Commit). */
export function invalidateBrandingCache(tenantId?: string): void {
  if (tenantId === undefined) brandingCache.clear();
  else brandingCache.delete(tenantId);
}

async function tenantNameTx(tx: TxClient, tenantId: string): Promise<string | null> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  return tenant?.name ?? null;
}

async function brandingSourceFromStoredTx(
  tx: TxClient,
  tenantId: string,
  stored: unknown,
): Promise<BrandingSource> {
  // Der Tenant-Name wird nur gebraucht, solange kein Branding gespeichert ist.
  return { stored, tenantName: stored === undefined ? await tenantNameTx(tx, tenantId) : null };
}

/** Branding innerhalb einer bestehenden Transaktion; nutzt den Prozess-Cache. */
export async function readBrandingSourceTx(
  tx: TxClient,
  tenantId: string,
  now: number = Date.now(),
): Promise<BrandingSource> {
  const cached = cachedBrandingSource(tenantId, now);
  if (cached) return cached;
  const stored = await readTenantSettingValue(tx, tenantId, SETTING_KEY_BRANDING);
  const source = await brandingSourceFromStoredTx(tx, tenantId, stored);
  rememberBrandingSource(tenantId, source, now);
  return source;
}

// ---------------------------------------------------------------------------
// Layout-Einstellungen
// ---------------------------------------------------------------------------

async function readAccountDisplayTx(
  tx: TxClient,
  ctx: TenantContext,
): Promise<AccountDisplaySource | null> {
  if (!ctx.actorId || (ctx.actorType !== 'STAFF' && ctx.actorType !== 'CLIENT_CONTACT')) {
    return null;
  }
  const where = { id: ctx.actorId, tenantId: ctx.tenantId, active: true };
  const select = { accessibleDisplay: true, ...DISPLAY_OPTIONS_SELECT } as const;
  return ctx.actorType === 'STAFF'
    ? tx.staffUser.findFirst({ where, select })
    : tx.clientContact.findFirst({ where, select });
}

/** Alle Layout-Rohwerte in einer bestehenden Transaktion (1 Settings-Abfrage). */
export async function readLayoutSettingsSourceTx(
  tx: TxClient,
  ctx: TenantContext,
  now: number = Date.now(),
): Promise<LayoutSettingsSource> {
  const cachedBranding = cachedBrandingSource(ctx.tenantId, now);
  const keys = cachedBranding
    ? [SETTING_KEY_MODULES, SETTING_KEY_PORTAL_FEATURES]
    : [SETTING_KEY_BRANDING, SETTING_KEY_MODULES, SETTING_KEY_PORTAL_FEATURES];
  const values = await readTenantSettingValues(tx, ctx.tenantId, keys);
  let branding = cachedBranding;
  if (!branding) {
    branding = await brandingSourceFromStoredTx(tx, ctx.tenantId, values.get(SETTING_KEY_BRANDING));
    rememberBrandingSource(ctx.tenantId, branding, now);
  }
  return {
    branding,
    modules: values.get(SETTING_KEY_MODULES),
    portalFeatures: values.get(SETTING_KEY_PORTAL_FEATURES),
    account: await readAccountDisplayTx(tx, ctx),
  };
}

// Request-Scope: cache() liefert je Anfrage und Akteur dasselbe Objekt. Auf
// Primitiven geschlüsselt, weil Layout und Seite eigene ctx-Objekte bauen.
// Außerhalb eines React-Renders (Server-Actions, Route-Handler, Tests ohne
// Request) ist cache() wirkungslos; jeder Aufruf liest dann frisch.
interface LayoutRequestScope {
  source?: Promise<LayoutSettingsSource>;
}

const layoutRequestScope = cache(
  (_tenantId: string, _actorId: string | null, _actorType: ActorType): LayoutRequestScope => ({}),
);

function scopeFor(ctx: TenantContext): LayoutRequestScope {
  return layoutRequestScope(ctx.tenantId, ctx.actorId, ctx.actorType);
}

function remember(
  scope: LayoutRequestScope,
  source: Promise<LayoutSettingsSource>,
): Promise<LayoutSettingsSource> {
  // Ein abgelehnter Promise, den (noch) niemand awaited, darf kein
  // unhandledRejection auslösen; Konsumenten sehen den Fehler trotzdem.
  source.catch(() => undefined);
  scope.source = source;
  return source;
}

/** Layout-Rohwerte der Anfrage; höchstens eine Transaktion je Request und Akteur. */
export function readLayoutSettingsSource(ctx: TenantContext): Promise<LayoutSettingsSource> {
  const scope = scopeFor(ctx);
  return (
    scope.source ??
    remember(
      scope,
      withTenantContext(ctx, (tx) => readLayoutSettingsSourceTx(tx, ctx)),
    )
  );
}

/**
 * Layout-Rohwerte plus weitere Layout-Daten (z. B. Glocken-Zähler) in derselben
 * Transaktion. Hat die Seite die Einstellungen in dieser Anfrage schon geladen,
 * werden sie wiederverwendet und nur `extra` läuft in einer eigenen Transaktion.
 */
export async function readLayoutSettingsSourceWith<T>(
  ctx: TenantContext,
  extra: (tx: TxClient) => Promise<T>,
): Promise<{ source: LayoutSettingsSource; extra: T }> {
  const scope = scopeFor(ctx);
  if (scope.source) {
    const [source, extraValue] = await Promise.all([scope.source, withTenantContext(ctx, extra)]);
    return { source, extra: extraValue };
  }
  const combined = withTenantContext(ctx, async (tx) => {
    const source = await readLayoutSettingsSourceTx(tx, ctx);
    return { source, extra: await extra(tx) };
  });
  remember(
    scope,
    combined.then((result) => result.source),
  );
  return combined;
}
