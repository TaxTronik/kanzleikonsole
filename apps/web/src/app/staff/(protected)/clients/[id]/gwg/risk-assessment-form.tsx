'use client';

import { useState, useTransition, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { RiskFactor } from '@/server/gwg/risk-score';
import { saveRiskAnswersAction } from './actions';

interface Props {
  checkId: string;
  clientId: string;
  factors: RiskFactor[];
  currentAnswers: Record<string, number>;
  currentScore: number | null;
  currentLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  disabled?: boolean;
}

export function RiskAssessmentForm({
  checkId,
  clientId,
  factors,
  currentAnswers,
  currentScore,
  currentLevel,
  disabled,
}: Props) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, number>>(currentAnswers);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function setAnswer(key: string, value: number) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await saveRiskAnswersAction({ checkId, clientId, answers });
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {factors.map((f) => (
        <div key={f.key}>
          <label className="label">{f.label}</label>
          <select
            className="input"
            value={answers[f.key] ?? 0}
            onChange={(e) => setAnswer(f.key, Number(e.target.value))}
            disabled={disabled}
          >
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ))}

      {currentScore !== null && currentLevel !== null && (
        <div className="rounded-md bg-gray-50 p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted uppercase tracking-wide">Risikobewertung</p>
            <p className="text-sm text-secondary">
              Score: <strong>{currentScore}</strong>
            </p>
          </div>
          <span className={
            currentLevel === 'HIGH' ? 'badge-red'
            : currentLevel === 'MEDIUM' ? 'badge-yellow'
            : 'badge-green'
          }>
            {currentLevel}
          </span>
        </div>
      )}

      {error && (
        <div className="alert-error-sm">{error}</div>
      )}

      {!disabled && (
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Berechnet…' : currentScore === null ? 'Bewertung berechnen' : 'Bewertung aktualisieren'}
        </button>
      )}
    </form>
  );
}
