'use client';

import { useEffect, useRef, useState, useTransition, type SubmitEvent } from 'react';
import { computeRiskScore, type RiskFactor } from '@/server/gwg/risk-score';
import { gwgRiskRevision } from '@/server/gwg/revisions';
import { saveRiskAnswersAction } from './actions';
import { useGwgEditState } from './edit-state-context';

/**
 * Deterministische CAS-Revision des serverseitig zurückgesetzten Risikoblocks
 * (claimCheckMutation mit invalidateRisk nullt Answers/Score/Level). Muss
 * exakt der Server-Berechnung entsprechen — deshalb dieselbe reine Funktion.
 */
const RESET_RISK_REVISION = gwgRiskRevision({
  riskAnswers: null,
  riskScore: null,
  riskLevel: null,
});

interface Props {
  checkId: string;
  clientId: string;
  factors: RiskFactor[];
  currentAnswers: Record<string, number>;
  currentScore: number | null;
  currentLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  currentRevision: string;
  disabled?: boolean;
}

export function RiskAssessmentForm({
  checkId,
  clientId,
  factors,
  currentAnswers,
  currentScore,
  currentLevel,
  currentRevision,
  disabled,
}: Props) {
  const { markDraft, riskInvalidationGeneration } = useGwgEditState();
  const [answers, setAnswers] = useState<Record<string, number>>(currentAnswers);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reviewReset, setReviewReset] = useState(false);
  const [revision, setRevision] = useState(currentRevision);
  const [riskResetNotice, setRiskResetNotice] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Revisionen, die dieses Formular selbst erzeugt hat (eigene Saves): ein
  // späterer RSC-Refresh mit derselben Revision darf den State nicht anfassen.
  const ownRevisions = useRef<Set<string>>(new Set([currentRevision]));

  // (1) Sofort-Signal: eine andere Karte (Personen/Rechtsträger) hat die
  // Risikobewertung serverseitig zurückgesetzt. Die erwartete Revision auf den
  // deterministischen Reset-Stand nachziehen, damit der nächste Save nicht am
  // CAS scheitert — die lokal gewählten Antworten bleiben erhalten.
  const handledInvalidation = useRef(riskInvalidationGeneration);
  useEffect(() => {
    if (riskInvalidationGeneration === handledInvalidation.current) return;
    handledInvalidation.current = riskInvalidationGeneration;
    ownRevisions.current.add(RESET_RISK_REVISION);
    setRevision(RESET_RISK_REVISION);
    setSaved(false);
    setRiskResetNotice(true);
  }, [riskInvalidationGeneration]);

  // (2) Prop-Reconciliation nach RSC-Refresh (Muster wie
  // use-identity-review-state): Eine NEUE Server-Revision, die nicht aus einem
  // eigenen Save stammt, wird übernommen, statt beim nächsten Save mit
  // „Bitte Seite neu laden" abgelehnt zu werden.
  const lastServerRevision = useRef(currentRevision);
  useEffect(() => {
    if (currentRevision === lastServerRevision.current) return;
    lastServerRevision.current = currentRevision;
    if (!ownRevisions.current.has(currentRevision)) {
      setRevision(currentRevision);
    }
  }, [currentRevision]);

  function setAnswer(key: string, value: number) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setReviewReset(false);
    startTransition(async () => {
      const r = await saveRiskAnswersAction({
        checkId,
        clientId,
        answers,
        expectedRevision: revision,
      });
      if (r.error) setError(r.error);
      else {
        if (r.revision) {
          ownRevisions.current.add(r.revision);
          setRevision(r.revision);
        }
        setSaved(true);
        setRiskResetNotice(false);
        if (r.reviewReset) {
          markDraft();
          setReviewReset(true);
        }
      }
    });
  }

  const allAnswered = factors.every((f) => answers[f.key] !== undefined && answers[f.key] !== null);
  // Die Berechnung selbst ist rein und umfasst nur wenige Faktoren. Sie wird
  // sofort im Browser angezeigt; der Server-Button speichert anschließend den
  // Snapshot samt Audit-Nachweis, ohne eine zweite vollständige Seitennachladung.
  const preview = allAnswered ? computeRiskScore(answers) : null;
  const shownScore = preview?.score ?? currentScore;
  const shownLevel = preview?.level ?? currentLevel;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {factors.map((f) => (
        <div key={f.key}>
          <label className="label">{f.label}</label>
          <select
            className="input"
            value={answers[f.key] ?? ''}
            onChange={(e) => setAnswer(f.key, Number(e.target.value))}
            disabled={disabled}
          >
            {/* Placeholder erzwingt eine BEWUSSTE Bewertung jedes Faktors — sonst
                wäre ein unbewerteter Faktor nicht von einer bewussten 0 zu
                unterscheiden und die Analyse fälschlich als LOW gespeichert. */}
            <option value="" disabled>
              — bitte bewerten —
            </option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ))}

      {shownScore !== null && shownLevel !== null && (
        <div className="rounded-md bg-gray-50 p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted uppercase tracking-wide">Risikobewertung</p>
            <p className="text-sm text-secondary">
              Score: <strong>{shownScore}</strong>
            </p>
          </div>
          <span
            className={
              shownLevel === 'HIGH'
                ? 'badge-red'
                : shownLevel === 'MEDIUM'
                  ? 'badge-yellow'
                  : 'badge-green'
            }
          >
            {shownLevel}
          </span>
        </div>
      )}

      {riskResetNotice && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          Durch die Änderung an Personen bzw. Rechtsträger-Angaben wurde die gespeicherte
          Risikobewertung zurückgesetzt (§ 10 Abs. 2 GwG — die Faktoren hängen von den erfassten
          Personen ab). Ihre Auswahl unten ist noch da: bitte prüfen und erneut speichern, bevor Sie
          zur Freigabe einreichen.
        </div>
      )}
      {error && <div className="alert-error-sm">{error}</div>}
      {saved && (
        <div className="alert-success-sm">
          Risikobewertung gespeichert.
          {reviewReset ? ' Die laufende Prüfung wurde zur erneuten Freigabe zurückgesetzt.' : ''}
        </div>
      )}

      {!disabled && (
        <div>
          <button type="submit" className="btn-primary" disabled={isPending || !allAnswered}>
            {isPending
              ? 'Speichert…'
              : currentScore === null
                ? 'Bewertung speichern'
                : 'Bewertung aktualisieren'}
          </button>
          {!allAnswered && (
            <p className="text-xs text-muted mt-1">
              Bitte alle Faktoren bewerten, bevor die Bewertung berechnet wird.
            </p>
          )}
        </div>
      )}
    </form>
  );
}
