// =============================================================================
// Onboarding-Status pro Mandant — abgeleitet aus dem aktuellen Resource-State.
//
// Es gibt bewusst KEIN persistentes "Onboarding-Stage"-Feld auf Client.
// Stattdessen entscheiden wir bei jedem Lesen aus den existierenden Zählern:
//   - COMPLETE     → Mandant ist GwG-verifiziert und intern aktiv (allowActive=true)
//                    und hat mindestens einen Ansprechpartner.
//   - IN_PROGRESS  → Mindestens ein Onboarding-Schritt erledigt, aber nicht complete.
//   - OPEN         → Stammdaten existieren, sonst nichts.
//
// Vorteil: bestehende (Pre-Wizard) Mandanten bekommen automatisch den richtigen
// Status, ohne dass eine Backfill-Migration nötig ist.
// =============================================================================

export type OnboardingStatus = 'COMPLETE' | 'IN_PROGRESS' | 'OPEN';

export interface OnboardingCountsInput {
  allowActive: boolean;
  contactsActive: number;
  gwgChecks: number;
  gwgInvites?: number;
  poas: number;
  requests: number;
}

export function computeOnboardingStatus(input: OnboardingCountsInput): OnboardingStatus {
  const hasAnyOnboardingActivity =
    input.contactsActive > 0 ||
    input.gwgChecks > 0 ||
    (input.gwgInvites ?? 0) > 0 ||
    input.poas > 0 ||
    input.requests > 0;

  if (input.allowActive && input.contactsActive > 0) return 'COMPLETE';
  if (hasAnyOnboardingActivity) return 'IN_PROGRESS';
  return 'OPEN';
}

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  COMPLETE: 'Abgeschlossen',
  IN_PROGRESS: 'Läuft',
  OPEN: 'Offen',
};

/**
 * Nächster sinnvoller Step im Wizard, wenn ein Berater "Weiter" klickt.
 * Greift dieselbe Logik wie das Wizard-UI auf.
 */
export function resumeStep(
  input: OnboardingCountsInput,
): 'contact' | 'gwg' | 'poa' | 'first_request' | 'done' {
  if (input.contactsActive === 0) return 'contact';
  if (!input.allowActive && (input.gwgInvites ?? 0) === 0 && input.gwgChecks === 0) return 'gwg';
  if (!input.allowActive) return 'gwg'; // GwG läuft, aber noch nicht verifiziert
  if (input.poas === 0) return 'poa';
  if (input.requests === 0) return 'first_request';
  return 'done';
}
