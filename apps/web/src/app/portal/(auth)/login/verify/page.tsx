// =============================================================================
// /portal/login/verify — Server-Component
//
// Der Magic-Link-Token wird NICHT mehr beim GET-Render konsumiert (das ist
// die klassische Falle: E-Mail-Security-Scanner / Link-Prefetcher wie
// Outlook SafeLinks, Mimecast, Virenfilter rufen den Link vorab per GET ab
// und verbrauchen den One-Time-Token, bevor der Mandant klickt → „Link
// ungültig"). Stattdessen: GET zeigt nur einen Bestätigungs-Button; erst
// der explizite POST (confirmMagicLinkAction) konsumiert den Token, setzt
// das Session-Cookie und redirectet. Damit sind Prefetch/Doppel-Render
// idempotent. Der Token verlässt nie das Client-Bundle (Hidden-Field im
// serverseitig gerenderten Form, kein useSearchParams).
// =============================================================================

import Link from 'next/link';
import { confirmMagicLinkAction } from '../actions';
import { safePortalReturnTo } from './safe-return-to';

// Hängt am Request (Token im Query) — nie statisch generierbar.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ token?: string; returnTo?: string; status?: string }>;
}

export default async function VerifyMagicLinkPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const returnTo = safePortalReturnTo(params.returnTo);

  if (!token) {
    return (
      <Shell>
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {params.status === 'invalid'
            ? 'Der Link ist ungültig, abgelaufen oder wurde bereits verwendet.'
            : 'Kein Token in der URL.'}
        </div>
        <Link href="/portal/login" className="btn-primary inline-block">
          Neuen Link anfordern
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-sm text-gray-600">
        Klicken Sie auf <strong>Anmelden</strong>, um sich in das
        Mandantenportal einzuloggen. Der Link ist einmalig gültig.
      </p>
      <form action={confirmMagicLinkAction}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" className="btn-primary w-full">
          Anmelden
        </button>
      </form>
      <Link href="/portal/login" className="text-xs text-gray-400 hover:underline">
        Neuen Link anfordern
      </Link>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-md">
        <div className="card p-8 text-center">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-gray-500 mb-6">Mandantenportal</p>
          <div className="space-y-3">{children}</div>
        </div>
      </div>
    </div>
  );
}
