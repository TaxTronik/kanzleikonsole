// =============================================================================
// Wizard-Schritt-Definitionen für Mandanten-Onboarding.
//
// Pflichtschritte (vom User explizit festgelegt): Stammdaten, GwG-Onboarding.
// Vollmacht-Schritt wird ausgeblendet, wenn das Modul deaktiviert ist.
// =============================================================================

import type { ModuleConfig } from '@/server/settings/modules';

export type StepKey = 'master_data' | 'contact' | 'gwg' | 'poa' | 'first_request' | 'done';

export interface StepDef {
  key: StepKey;
  label: string;
  required: boolean; // true = darf nicht übersprungen werden
}

export function stepsForTenant(modules: ModuleConfig): StepDef[] {
  const steps: StepDef[] = [
    { key: 'master_data', label: 'Stammdaten', required: true },
    { key: 'contact', label: 'Ansprechpartner + Portal-Zugang', required: false },
    { key: 'gwg', label: 'GwG-Onboarding', required: true },
  ];
  if (modules.poaMode !== 'OFF') {
    steps.push({ key: 'poa', label: 'Vollmacht', required: false });
  }
  steps.push({ key: 'first_request', label: 'Erste Anforderung', required: false });
  steps.push({ key: 'done', label: 'Fertig', required: false });
  return steps;
}

export function stepIndex(steps: StepDef[], key: StepKey): number {
  const i = steps.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
}

export function nextStep(steps: StepDef[], current: StepKey): StepKey | null {
  const i = stepIndex(steps, current);
  return i < steps.length - 1 ? steps[i + 1]!.key : null;
}
