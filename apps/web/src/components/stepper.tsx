import { Check } from 'lucide-react';

// =============================================================================
// Stepper — geführter Fortschritt für Setup-/Prüfprozesse (z. B. n8n-Setup,
// GwG-Prüfung). Reine Darstellung (server-kompatibel), Styling in globals.css.
// States: done (Häkchen) / active (Ring) / open (neutral). Die aktive Stufe
// ist typischerweise die erste nicht-erledigte.
// =============================================================================

export type StepState = 'done' | 'active' | 'open';

export interface StepperStep {
  label: string;
  sub?: string;
  state: StepState;
}

export function Stepper({ steps }: { steps: StepperStep[] }) {
  return (
    <ol className="stepper">
      {steps.map((step, i) => (
        <li key={step.label} className={`step ${step.state}`}>
          <span className="step-dot" aria-hidden>
            {step.state === 'done' ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span className="step-txt">
            <span className="step-title">{step.label}</span>
            {step.sub ? <span className="step-sub">{step.sub}</span> : null}
          </span>
          {/* Connector als Flex-Element NACH dem Text: startet erst hinter dem
              Schritt-Text und endet am nächsten Punkt — kein Durchkreuzen mehr. */}
          {i < steps.length - 1 ? <span className="step-line" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}

/** Ergänzt done-Flags um den active-State (erste nicht-erledigte Stufe). */
export function withActiveStep<T extends { done: boolean }>(
  steps: T[],
): (Omit<T, 'done'> & { state: StepState })[] {
  const firstOpen = steps.findIndex((s) => !s.done);
  return steps.map((step, i) => {
    const { done: _done, ...rest } = step;
    return {
      ...rest,
      state: step.done ? 'done' : i === firstOpen ? 'active' : 'open',
    };
  });
}
