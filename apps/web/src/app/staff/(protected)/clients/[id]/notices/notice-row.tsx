// =============================================================================
// Zeile der Bescheidliste (Review-Befund K-04). Rendert nur das Zeilenmodell
// (toNoticeRowVm); Fristtage, Dringlichkeit, Badges und Nachweise werden dort
// rein und getestet abgeleitet, nicht im JSX.
// =============================================================================

import Link from 'next/link';
import { FileText } from 'lucide-react';
import { NoticeStatusSelect } from './status-select';
import type {
  AmountDeltaVm,
  DeadlineVm,
  NoticeRowVm,
  NoticeStatusVm,
  RetrievalEvidenceVm,
} from './notice-row-vm';

export function NoticeRow({ row }: { row: NoticeRowVm }) {
  return (
    <tr className="hover:bg-gray-50">
      <NoticeCell row={row} />
      <td className="px-4 py-3 text-secondary">
        {row.noticeDate}
        <div className="text-xs text-muted">{row.deliveryLabel}</div>
        <div className="text-xs text-muted">{row.dateBasisLabel}</div>
        <DataRetrievalEvidenceDetails evidence={row.retrieval} />
        {row.legalRemedyHint && <div className="text-xs text-amber-700">{row.legalRemedyHint}</div>}
      </td>
      <td className="px-4 py-3 font-mono text-primary">{row.assessedAmount}</td>
      <td className="px-4 py-3 font-mono text-secondary">{row.expectedAmount}</td>
      <td className="px-4 py-3 font-mono">
        <AmountDifference delta={row.delta} />
      </td>
      <td className="px-4 py-3">
        <DeadlineAssessment deadline={row.deadline} />
      </td>
      <td className="px-4 py-3">
        <NoticeStatus status={row.status} />
        <NoticeStatusSelect {...row.statusSelect} />
      </td>
    </tr>
  );
}

function NoticeCell({ row }: { row: NoticeRowVm }) {
  return (
    <td className="px-4 py-3">
      <div className="font-medium text-primary">{row.kindLabel}</div>
      <div className="text-xs text-muted">
        {row.period}
        {row.fileNumberSuffix}
      </div>
      {row.documentHref && (
        <Link
          href={row.documentHref}
          className="text-xs text-brand-700 hover:underline inline-flex items-center gap-1 mt-1"
        >
          <FileText className="h-3 w-3" />
          PDF
        </Link>
      )}
      {row.filing && (
        <div className="text-xs mt-1 flex items-center gap-1 text-muted">
          <span>↪ aus Erklärung</span>
          {row.filing.portalShared && (
            <span className="badge-green text-xs" title="Mandant sieht die Erklärung im Portal">
              Portal
            </span>
          )}
        </div>
      )}
    </td>
  );
}

function DataRetrievalEvidenceDetails({ evidence: e }: { evidence: RetrievalEvidenceVm }) {
  return (
    <>
      {e.issuedAt && <div className="text-xs text-muted">Erlassen: {e.issuedAt}</div>}
      {e.notificationDate && (
        <div className="text-xs text-muted">Benachrichtigung: {e.notificationDate}</div>
      )}
      {e.notificationStatus !== null && (
        <div className="text-xs text-muted">Benachrichtigungsstatus: {e.notificationStatus}</div>
      )}
      {e.consentStatus !== null && (
        <div className="text-xs text-muted">Einwilligung 2026: {e.consentStatus}</div>
      )}
      {e.eligibility2027Status !== null && (
        <div className="text-xs text-muted">Voraussetzungen ab 2027: {e.eligibility2027Status}</div>
      )}
      {e.postalRequest && (
        <div className="text-xs text-muted">
          Postantrag ab 2027: {e.postalRequest.status}
          {e.postalRequest.receivedSuffix}
        </div>
      )}
      {e.legacyFallback && (
        <div className="text-xs text-amber-700">
          Altbestand: Erlass-/Benachrichtigungstag nicht dokumentiert; Frist unverändert übernommen
        </div>
      )}
      {e.decisiveRetrieval && (
        <div className="text-xs text-amber-700">Maßgeblicher Abruf: {e.decisiveRetrieval}</div>
      )}
    </>
  );
}

function AmountDifference({ delta }: { delta: AmountDeltaVm }) {
  if (delta.kind === 'none') return <span className="text-disabled">—</span>;
  if (delta.kind === 'higher') return <span className="text-red-700">+{delta.amount}</span>;
  if (delta.kind === 'lower') return <span className="text-emerald-700">{delta.amount}</span>;
  return <span className="text-muted">±0</span>;
}

function CalculatedDeadlineAssessment({ calculated }: { calculated: DeadlineVm['calculated'] }) {
  if (!calculated) return null;
  return (
    <>
      <span
        className={
          calculated.reviewOpen ? 'text-xs font-medium text-amber-700' : 'text-xs text-muted'
        }
      >
        {calculated.reviewOpen
          ? 'Kontrollvorschlag – fachliche Freigabe offen'
          : 'Kontrollvorschlag'}
      </span>
      <span className={calculated.urgent ? 'text-red-700 font-medium' : 'text-secondary'}>
        {calculated.date}
      </span>
      <span className="text-xs text-muted">{calculated.daysLabel}</span>
    </>
  );
}

function DeadlineAssessment({ deadline: d }: { deadline: DeadlineVm }) {
  return (
    <div className="flex flex-col gap-0.5">
      <CalculatedDeadlineAssessment calculated={d.calculated} />
      {d.legacyDate && (
        <>
          <span className="text-xs font-medium text-amber-700">Altbestand – ungeprüfte Frist</span>
          <span className="text-amber-800">{d.legacyDate}</span>
        </>
      )}
      {d.riskDate && (
        <>
          <span className="text-xs font-medium text-amber-700">
            Interner Risikotermin – keine Rechtsfrist
          </span>
          <span className="text-amber-800">{d.riskDate}</span>
        </>
      )}
      {d.manualReview && (
        <span className="text-xs font-medium text-amber-700">
          Manuelle Fristprüfung erforderlich
        </span>
      )}
      {d.fictionScenarioDate && (
        <span className="text-xs text-amber-700">
          Szenario gesetzliche Fiktion: {d.fictionScenarioDate}
        </span>
      )}
      {d.claimedAccessScenarioDate && (
        <span className="text-xs text-amber-700">
          Szenario behaupteter späterer Zugang: {d.claimedAccessScenarioDate}
        </span>
      )}
      {d.reasons.map((reason) => (
        <span key={reason.key} className="text-xs text-amber-700">
          {reason.label}
        </span>
      ))}
      {d.reinstatementReviewRequired && (
        <span className="text-xs font-medium text-red-700">
          Wiedereinsetzung nach § 110 AO gesondert prüfen
        </span>
      )}
      {d.legacyUnassessed && (
        <span className="text-xs text-amber-700">Altbestand fachlich noch nicht beurteilt</span>
      )}
    </div>
  );
}

function NoticeStatus({ status: s }: { status: NoticeStatusVm }) {
  const badge = s.badge && <span className={s.badge.className}>{s.badge.label}</span>;
  return (
    <>
      {s.badge?.beforePartialRelief && badge}
      {s.partialReliefDate && (
        <div className="text-xs text-muted mt-1">Teilabhilfe bekannt am {s.partialReliefDate}</div>
      )}
      {s.badge && !s.badge.beforePartialRelief && badge}
      {s.appealDecisionDate && (
        <div className="text-xs text-muted mt-1">
          Einspruchsentscheidung bekannt am {s.appealDecisionDate}
        </div>
      )}
      {s.decisionInstructionMissing && (
        <div className="text-xs text-amber-700">
          Jahresfrist wegen Belehrungsmangel (§ 55 Abs. 2 FGO)
        </div>
      )}
      {s.klage && (
        <div
          className={`text-xs mt-1 ${s.klage.urgent ? 'text-red-700 font-medium' : 'text-muted'}`}
        >
          Klagefrist: {s.klage.date}
          {s.klage.suffix}
        </div>
      )}
    </>
  );
}
