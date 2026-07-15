// =============================================================================
// Onboarding-Status pro Mandant — abgeleitet aus dem aktuellen Resource-State.
//
// Es gibt keinen frei manipulierbaren Stage-String. Nur der bewusste Abschluss
// wird persistiert; bis dahin leitet sich der Fortschritt aus Ressourcen ab:
//   - COMPLETE     → Das Erst-Onboarding wurde bewusst und auditierbar beendet.
//   - IN_PROGRESS  → Mindestens ein Onboarding-Schritt erledigt, aber nicht complete.
//   - OPEN         → Stammdaten existieren, sonst nichts.
//
// Bestehende Mandanten mit aktivem Ansprechpartner und historisch verifiziertem
// GwG-Check werden bei der Einführung des Markers einmalig backfilled.
// =============================================================================

export type OnboardingStatus = 'COMPLETE' | 'IN_PROGRESS' | 'OPEN';

export interface OnboardingCountsInput {
  allowActive: boolean;
  onboardingCompletedAt?: Date | string | null;
  contactsActive: number;
  gwgChecks: number;
  gwgInvites?: number;
  poas: number;
  requests: number;
}

export function computeOnboardingStatus(input: OnboardingCountsInput): OnboardingStatus {
  // Der bewusste Abschluss ist die einzige belastbare Aussage über das
  // Erst-Onboarding. Spätere Kontaktwechsel oder GwG-Wiederholungsprüfungen
  // dürfen einen historisch abgeschlossenen Vorgang nicht wieder öffnen.
  if (input.onboardingCompletedAt) return 'COMPLETE';

  const hasAnyOnboardingActivity =
    input.allowActive ||
    input.contactsActive > 0 ||
    input.gwgChecks > 0 ||
    (input.gwgInvites ?? 0) > 0 ||
    input.poas > 0 ||
    input.requests > 0;

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
  if (input.onboardingCompletedAt) return 'done';
  if (input.contactsActive === 0) return 'contact';
  if (!input.allowActive && (input.gwgInvites ?? 0) === 0 && input.gwgChecks === 0) return 'gwg';
  if (!input.allowActive) return 'gwg'; // GwG läuft, aber noch nicht verifiziert
  if (input.poas === 0) return 'poa';
  if (input.requests === 0) return 'first_request';
  return 'done';
}
