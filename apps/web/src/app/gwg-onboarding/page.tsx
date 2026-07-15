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
import { readResolvedConsentOptionsTx } from '@/server/privacy/consent-catalog';
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
  const privacy = await withSystemContext(invite.tenant.id, async (tx) => {
    const notice = await renderNoticeForTenantTx(tx, invite.tenant.id);
    const consentOptions = notice.complete
      ? await readResolvedConsentOptionsTx(tx, invite.tenant.id)
      : [];
    // Im öffentlichen RSC-Payload erscheinen ausschließlich aktuell
    // angebotene und vollständig auflösbare Optionen. Eine verwaiste
    // Dienstleister-Verknüpfung muss zuerst im ACP repariert werden und darf
    // den Mandanten nicht erst beim finalen Absenden scheitern lassen.
    return {
      notice,
      consentOptions: consentOptions.filter((option) => option.active && !option.providerMissing),
    };
  });

  if (!privacy.notice.complete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-page p-4">
        <div className="card p-8 max-w-lg w-full text-center">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted mb-6">{invite.tenant.name} — GwG-Identifizierung</p>
          <div className="rounded-md border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
            <p className="font-medium">Das Onboarding ist noch nicht freigegeben.</p>
            <p className="mt-1">
              Die Datenschutzhinweise der Kanzlei sind noch unvollständig. Bitte wenden Sie sich an
              die Kanzlei; dort müssen die Pflichtangaben ergänzt werden.
            </p>
          </div>
        </div>
      </div>
    );
  }

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
          noticeBody={privacy.notice.body}
          noticeVersion={privacy.notice.version}
          consentOptions={privacy.consentOptions}
        />
      </div>
    </div>
  );
}
