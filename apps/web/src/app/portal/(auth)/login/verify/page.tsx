import type { ReactNode } from 'react';
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
//
// Referrer (Audit 2026-06 Befund 5): Die Seite trägt den Token im URL-Query.
// Die Route liefert bereits `Referrer-Policy: no-referrer` als Header
// (next.config.mjs H-3) — zusätzlich referrerPolicy="no-referrer" an den
// internen Links, damit der Schutz nicht allein an der Header-Konfiguration
// hängt (Defense in Depth, wirkt auch wenn die next.config-Regel je verrutscht).
// =============================================================================

import Link from 'next/link';
import { confirmMagicLinkAction } from '../actions';
import { inspectMagicLink } from '@/server/auth/magic-link';
import { safePortalReturnTo } from './safe-return-to';

// Hängt am Request (Token im Query) — nie statisch generierbar.

interface PageProps {
  searchParams: Promise<{ token?: string; returnTo?: string; status?: string }>;
}

export default async function VerifyMagicLinkPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const returnTo = safePortalReturnTo(params.returnTo);
  const inspection = token ? await inspectMagicLink(token) : null;

  if (!token || !inspection) {
    return (
      <Shell>
        <div className="alert-error-sm">
          {params.status === 'invalid' || token
            ? 'Der Link ist ungültig, abgelaufen oder wurde bereits verwendet.'
            : 'Kein Token in der URL.'}
        </div>
        <Link
          href="/portal/login"
          referrerPolicy="no-referrer"
          className="btn-primary inline-block"
        >
          Neuen Link anfordern
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-sm text-secondary">
        {inspection.profiles.length > 1
          ? 'Wählen Sie aus, für welches Mandat Sie das Portal öffnen möchten.'
          : 'Bestätigen Sie das Mandantenprofil, das Sie öffnen möchten.'}
      </p>
      <div className="space-y-2 text-left">
        {inspection.profiles.map((profile) => (
          <form key={profile.contactId} action={confirmMagicLinkAction}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="contactId" value={profile.contactId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <button
              type="submit"
              className="w-full rounded-lg border border-default bg-white px-4 py-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50 dark:bg-gray-900"
            >
              <span className="block text-sm font-semibold text-primary">{profile.clientName}</span>
              <span className="block text-xs text-muted">Als {profile.contactName} öffnen</span>
            </button>
          </form>
        ))}
      </div>
      <p className="text-xs text-disabled">Der Link ist einmalig gültig.</p>
      <Link
        href="/portal/login"
        referrerPolicy="no-referrer"
        className="text-xs text-disabled hover:underline"
      >
        Neuen Link anfordern
      </Link>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-page">
      <div className="w-full max-w-md">
        <div className="card p-8 text-center">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted mb-6">Mandantenportal</p>
          <div className="space-y-3">{children}</div>
        </div>
      </div>
    </div>
  );
}
