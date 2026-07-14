// =============================================================================
// /gwg-onboarding?token=… — Mandant füllt selbst aus, ohne Portal-Account
//
// Public-Pfad, geschützt nur durch den Magic-Link-Token. Wizard-UI in
// `OnboardingWizard` (Client-Component). Submit erfolgt via Server-Action,
// die wieder den Token mitprüft.
// =============================================================================

import { headers } from 'next/headers';
import { withSystemContext } from '@taxtronik/db';
import { checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';
import { GENERIC_TOKEN_ERROR, loadInviteByRawToken } from '@/server/gwg-onboarding/service';
import { renderNoticeForTenantTx } from '@/server/privacy/service';
import { OnboardingWizard } from './wizard';

export default async function GwgOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? '';

  // Rate-Limit für den unauthentifizierten Token-Lookup (DB-Lookup + Status-
  // Write pro Request, Muster wie gwg-upload-ip in actions.ts). Bei
  // Überschreitung DIESELBE generische Fehlansicht wie bei ungültigem Token —
  // eine eigene „zu viele Versuche"-Meldung wäre ein Token-Probing-Orakel.
  const ip = getClientIp(await headers());
  const rl = await checkIpOrGlobalLimit(
    'gwg-invite-load',
    ip,
    { max: 30, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  const result = rl.ok
    ? await loadInviteByRawToken(token)
    : { ok: false as const, error: GENERIC_TOKEN_ERROR };

  if (!result.ok) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-page p-4">
        <div className="card p-8 max-w-md w-full text-center">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted mb-6">GwG-Identifizierung</p>
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{result.error}</div>
        </div>
      </div>
    );
  }

  const { invite } = result;
  // Datenschutzhinweise (Teil A) tenant-spezifisch rendern (System-Kontext:
  // Public-Pfad, nur durch den Token geschützt).
  const notice = await withSystemContext(invite.tenant.id, (tx) =>
    renderNoticeForTenantTx(tx, invite.tenant.id),
  );
  return (
    <div className="min-h-screen bg-surface-page py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted">{invite.tenant.name} — GwG-Identifizierung</p>
        </div>
        <OnboardingWizard
          token={token}
          inviteName={invite.inviteName}
          client={invite.client}
          noticeBody={notice.body}
          noticeVersion={notice.version}
        />
      </div>
    </div>
  );
}
