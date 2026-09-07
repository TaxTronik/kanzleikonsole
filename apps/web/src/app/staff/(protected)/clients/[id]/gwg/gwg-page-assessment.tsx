import { Stage } from '@/components/stage';
import { DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { gwgRiskRevision } from '@/server/gwg/revisions';
import { gwgProfessionalReviewSnapshotHash } from '@/server/gwg/review-snapshot';
import { RiskAssessmentForm } from './risk-assessment-form';
import { GwgDecisionForms } from './decision-forms';
import type { GwgPageModel } from './gwg-page-model';
export function GwgAssessment({ model, canVerify }: { model: GwgPageModel; canVerify: boolean }) {
  const { client, check, gwgSteps } = model;
  if (!check || model.destroyed) return null;
  const professionalReviewSnapshotHash =
    check.status === 'IN_REVIEW' ? gwgProfessionalReviewSnapshotHash({ ...check, client }) : null;
  return (
    <>
      {' '}
      {/* Risikobewertung bewusst als LETZTER Schritt vor der Entscheidung:
                die Faktoren (PEP, Struktur) hängen von den erfassten Personen ab —
                jede Personen-/Rechtsträger-Änderung setzt eine gespeicherte
                Bewertung serverseitig zurück (§ 10 Abs. 2 GwG). Stand die
                Bewertung als Schritt 1 oben, lief man im normalen Workflow
                zwangsläufig in diesen Reset. */}
      <Stage
        num={3}
        state={gwgSteps[2]!.state}
        title="Risikobewertung"
        sub="Antworten basierend auf Branche, Sitz, PEP-Status und Geschäftsmodell — als letzter Schritt vor der Entscheidung (Änderungen an Personen oder Rechtsträger setzen eine gespeicherte Bewertung zurück)."
        badge={
          check.riskLevel ? (
            <span className="badge badge-yellow">{check.riskLevel}</span>
          ) : (
            <span className="badge badge-gray">Offen</span>
          )
        }
      >
        <RiskAssessmentForm
          checkId={check.id}
          clientId={client.id}
          factors={DEFAULT_FACTORS}
          currentAnswers={(check.riskAnswers as Record<string, number>) ?? {}}
          currentScore={check.riskScore ?? null}
          currentLevel={check.riskLevel ?? null}
          currentRevision={gwgRiskRevision(check)}
          disabled={
            check.status === 'VERIFIED' || check.status === 'REJECTED' || check.status === 'EXPIRED'
          }
        />
      </Stage>
      {/* Verifikation oder Ablehnung */}
      {(check.status === 'DRAFT' || check.status === 'IN_REVIEW') && (
        <Stage
          num={4}
          state={gwgSteps[3]!.state}
          title="Entscheidung"
          sub="Verifizieren oder ablehnen — begründungspflichtig durch Berufsträger."
          badge={
            check.status === 'DRAFT' ? (
              <span className="badge badge-gray">Entwurf</span>
            ) : (
              <span className="badge badge-yellow">In Prüfung</span>
            )
          }
        >
          <GwgDecisionForms
            checkId={check.id}
            clientId={client.id}
            status={check.status}
            reviewSubmittedAt={check.reviewSubmittedAt?.toISOString() ?? null}
            canVerify={canVerify}
            reviewSnapshotHash={professionalReviewSnapshotHash}
          />
        </Stage>
      )}
    </>
  );
}
