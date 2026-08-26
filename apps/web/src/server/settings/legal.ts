// =============================================================================
// Rechtliche Hinweise (Impressum + Datenschutzerklärung)
//
// Liegt in `tenant_setting` unter `legal`. Wird auf Login-Seiten (Staff + Portal)
// rechtsverbindlich verlinkt — überall sonst nur dezent im Footer (oder gar nicht).
//
// Zwei Reader:
//   - readLegal(ctx)        — innerhalb authentifizierter Sessions
//   - readLegalForSlug(slug)— public (Login-Seite hat noch keinen Tenant-Context)
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { prismaOwner } from '@/server/db/prisma-owner';

const KEY = 'legal';

export interface LegalLinks {
  /** Vollständige URL (z. B. https://kanzlei-mueller.de/impressum) */
  impressumUrl: string;
  /** Vollständige URL zur Datenschutzerklärung */
  privacyUrl: string;
}

export const DEFAULT_LEGAL: LegalLinks = {
  impressumUrl: '',
  privacyUrl: '',
};

function normalize(value: unknown): LegalLinks {
  const v = (value ?? {}) as Partial<LegalLinks>;
  return {
    impressumUrl: typeof v.impressumUrl === 'string' ? v.impressumUrl.trim() : '',
    privacyUrl: typeof v.privacyUrl === 'string' ? v.privacyUrl.trim() : '',
  };
}

export async function readLegal(ctx: TenantContext): Promise<LegalLinks> {
  return withTenantContext(ctx, async (tx) => {
    const value = await readTenantSettingValue(tx, ctx.tenantId, KEY);
    return value === undefined ? DEFAULT_LEGAL : normalize(value);
  });
}

/**
 * Public-safe Reader: resolved den Tenant über den Slug. Wird auf Login-Seiten
 * verwendet, bevor eine Session existiert.
 *
 * Bewusst über prismaOwner (kein RLS) — Tenant-Settings sind pro-Tenant strikt
 * isoliert, weil wir explizit nach (tenantSlug, key='legal') filtern. Keine
 * sensiblen Daten — nur zwei URLs, die ohnehin öffentlich verlinkt werden.
 */
export async function readLegalForSlug(slug: string): Promise<LegalLinks> {
  const tenant = await prismaOwner.tenant.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!tenant) return DEFAULT_LEGAL;
  const value = await readTenantSettingValue(prismaOwner, tenant.id, KEY);
  return value === undefined ? DEFAULT_LEGAL : normalize(value);
}

export async function writeLegal(ctx: TenantContext, links: LegalLinks): Promise<void> {
  const stored = normalize(links);
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY,
      value: stored as object,
      updatedBy: ctx.actorId,
    });
  });
}
