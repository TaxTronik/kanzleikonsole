import { Check } from 'lucide-react';
import Link from 'next/link';
import type { StepDef, StepKey } from './steps';

export interface StepperItemState {
  key: StepKey;
  label: string;
  done: boolean;
  current: boolean;
  required: boolean;
}

export function Stepper({
  steps,
  currentKey,
  doneKeys,
  clientId,
}: {
  steps: StepDef[];
  currentKey: StepKey;
  doneKeys: Set<StepKey>;
  clientId?: string;
}) {
  const currentIndex = steps.findIndex((step) => step.key === currentKey);
  const onboardingComplete = doneKeys.has('done');
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs mb-6">
      {steps.map((s, i) => {
        const done = doneKeys.has(s.key);
        const current = s.key === currentKey;
        const navigable =
          Boolean(clientId) &&
          !current &&
          s.key !== 'master_data' &&
          (i < currentIndex || done || onboardingComplete);
        const cls = current
          ? 'inline-flex items-center gap-1 rounded-full px-3 py-1.5 bg-brand-600 text-white font-medium'
          : done
            ? 'inline-flex items-center gap-1 rounded-full px-3 py-1.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
            : 'inline-flex items-center gap-1 rounded-full px-3 py-1.5 bg-gray-100 text-muted';
        return (
          <li key={s.key} className="flex items-center">
            {navigable ? (
              <Link
                href={`/staff/clients/onboarding/${clientId}?step=${s.key}`}
                className={`${cls} transition hover:ring-2 hover:ring-brand-300`}
                title={`Zurück zu „${s.label}“`}
              >
                {done ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <span className="h-4 w-4 inline-flex items-center justify-center rounded-full bg-white/40 text-[10px] font-semibold">
                    {i + 1}
                  </span>
                )}
                {s.label}
                {!s.required && <span className="text-[10px] opacity-70">(optional)</span>}
              </Link>
            ) : (
              <span className={cls} aria-current={current ? 'step' : undefined}>
                {done ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <span className="h-4 w-4 inline-flex items-center justify-center rounded-full bg-white/40 text-[10px] font-semibold">
                    {i + 1}
                  </span>
                )}
                {s.label}
                {!s.required && !current && (
                  <span className="text-[10px] opacity-70">(optional)</span>
                )}
              </span>
            )}
            {i < steps.length - 1 && <span className="mx-1 text-disabled">›</span>}
          </li>
        );
      })}
    </ol>
  );
}
