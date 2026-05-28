// =============================================================================
// Portal-Auth-Layout — rendert Mandanten-Login mit Pflicht-Footer (Impressum +
// Datenschutz). Legal-Links werden public über tenantSlug='default' geladen.
// =============================================================================

import { readLegalForSlug } from '@/server/settings/legal';
import { LegalFooter } from '@/components/legal-footer';

export default async function PortalAuthLayout({ children }: { children: React.ReactNode }) {
  const legal = await readLegalForSlug('default');
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-surface-page py-8">
      <div className="w-full max-w-md">
        {children}
        <LegalFooter links={legal} />
      </div>
    </div>
  );
}
