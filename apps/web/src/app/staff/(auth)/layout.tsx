import type { ReactNode } from 'react';
// =============================================================================
// Staff-Auth-Layout — rendert Login-Page mit Kanzlei-Branding (Logo/Name, wie
// in der Sidebar) und Pflicht-Footer (Impressum + Datenschutz). Branding und
// Legal-Links werden public über tenantSlug='default' geladen.
// =============================================================================

import { readLegalForSlug } from '@/server/settings/legal';
import { readBrandingForSlug } from '@/server/settings/branding';
import { LegalFooter } from '@/components/legal-footer';
import { TenantLogo } from '@/components/tenant-logo';
import { brandPaletteStyle } from '@/lib/brand-palette';

export default async function StaffAuthLayout({ children }: { children: ReactNode }) {
  const [legal, branding] = await Promise.all([
    readLegalForSlug('default'),
    readBrandingForSlug('default'),
  ]);
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="app-shell min-h-screen flex flex-col items-center justify-center bg-surface-page py-8"
      style={brandPaletteStyle(branding.accentColor)}
    >
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          {branding.logoDataUrl || branding.logoDataUrlDark ? (
            <TenantLogo
              branding={branding}
              alt={branding.displayName}
              className="h-10 max-w-full object-contain"
            />
          ) : (
            <span className="brand-wordmark text-2xl font-bold">{branding.displayName}</span>
          )}
          {branding.subtitle && (
            <span className="mt-1 text-sm text-muted">{branding.subtitle}</span>
          )}
        </div>
        {children}
        <LegalFooter links={legal} />
      </div>
    </main>
  );
}
