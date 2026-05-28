// =============================================================================
// /gwg-onboarding?token=… — Mandant füllt selbst aus, ohne Portal-Account
//
// Public-Pfad, geschützt nur durch den Magic-Link-Token. Wizard-UI in
// `OnboardingWizard` (Client-Component). Submit erfolgt via Server-Action,
// die wieder den Token mitprüft.
// =============================================================================

import { loadInviteByRawToken } from '@/server/gwg-onboarding/service';
import { OnboardingWizard } from './wizard';

export default async function GwgOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? '';
  const result = await loadInviteByRawToken(token);

  if (!result.ok) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-page p-4">
        <div className="card p-8 max-w-md w-full text-center">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted mb-6">GwG-Identifizierung</p>
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
            {result.error}
          </div>
        </div>
      </div>
    );
  }

  const { invite } = result;
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
        />
      </div>
    </div>
  );
}
