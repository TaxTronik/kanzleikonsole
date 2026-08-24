// =============================================================================
// /staff/clients/:id/notices — Bescheid-Postfach pro Mandant
//
// Listet alle Bescheide mit Soll/Ist-Vergleich, Einspruchsfrist-Hinweis
// und Status. Quick-Actions: als geprüft markieren, Einspruch einlegen.
// =============================================================================

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileWarning, Plus, FileText } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { FilingsSection } from './filings/filings-section';
import { NoticeStatusSelect } from './status-select';
import { NOTICE_STATUS_TRANSITIONS } from './transitions';
import { taxNoticeKlageFristErledigt } from '@/server/fristen/eintrag';

import { berlinTodayUtcMidnight, fmtDateShort, fmtEUR } from '@/lib/fmt';
import { NOTICE_KIND_LABELS, NOTICE_STATUS_LABELS } from '@/lib/domain-labels';
const DELIVERY_LABELS: Record<string, string> = {
  POST: 'Post',
  POST_ABROAD: 'Post ins Ausland',
  ELECTRONIC: 'elektronisch übermittelt',
  DATA_RETRIEVAL: 'zum Datenabruf bereitgestellt',
  FORMAL: 'förmlich zugestellt',
  PERSONAL: 'persönlich übergeben',
  OTHER: 'sonstiger Zugang',
};

const DATE_BASIS_LABELS: Record<string, string> = {
  LEGACY_UNVERIFIED: 'Altbestand: Datumsbedeutung ungeprüft',
  DISPATCH_DATE: 'nachgewiesener Aufgabe-/Übermittlungstag',
  PROVISION_DATE: 'nachgewiesener Bereitstellungstag',
  ACTUAL_ACCESS_DETERMINED: 'fachlich festgestellter Bekanntgabetag',
  DOCUMENT_DATE_RISK_ONLY: 'Bescheiddatum, nur interner Risikobezug',
};

const REVIEW_REASON_LABELS: Record<string, string> = {
  DISPATCH_DATE_UNKNOWN: 'Aufgabe-/Übermittlungstag unbekannt',
  DETERMINED_NOTIFICATION_DATE_MISSING: 'festgestellter Bekanntgabetag fehlt',
  NON_RECEIPT_REQUIRES_EVIDENCE_REVIEW: 'Nichtzugang ist fachlich zu würdigen',
  RECORDED_EARLIER_ACCESS_AFTER_FICTION:
    'als früher erfasster Eingang liegt nach dem Fiktionstag; Einordnung prüfen',
  LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW: 'behaupteter späterer Zugang ist zu würdigen',
  CLAIMED_LATER_ACCESS_NOT_AFTER_FICTION:
    'als später behaupteter Zugang liegt nicht nach dem Fiktionstag; Einordnung prüfen',
  LEGAL_REMEDY_INSTRUCTION_UNCLEAR: 'Rechtsbehelfsbelehrung ist unklar',
  NOTIFICATION_WORKDAY_REVIEW_REQUIRED: 'Feiertagskontext des Bekanntgabetags ist offen',
  DEADLINE_WORKDAY_REVIEW_REQUIRED: 'Feiertagskontext des Fristendes ist offen',
  HOLIDAY_LOCALITY_UNKNOWN: 'konkreter Feiertagsort ist nicht dokumentiert',
  RISK_DATE_ONLY: 'nur Bescheiddatum als interner Risikobezug vorhanden',
  DELIVERY_EVIDENCE_INSUFFICIENT: 'Ausgangsdatum ist nicht ausreichend nachgewiesen',
  ACCESS_NOT_PROFESSIONALLY_DETERMINED: 'Zugang ist nicht fachlich festgestellt',
  DETERMINED_LATER_ACCESS_NOT_AFTER_FICTION:
    'als später festgestellter Zugang liegt nicht nach dem Fiktionstag; Einordnung prüfen',
  ISSUED_AT_UNKNOWN: 'Erlassdatum fehlt',
  PROVISION_DATE_UNKNOWN: 'Bereitstellungstag fehlt',
  PROVISION_NOT_SUFFICIENTLY_EVIDENCED: 'Bereitstellung ist nicht ausreichend nachgewiesen',
  PROVISION_PROFESSIONAL_APPROVAL_PENDING:
    'technischer Bereitstellungsnachweis vorhanden; fachliche Freigabe steht aus',
  ACTIVE_CONSENT_2026_NOT_DOCUMENTED: 'Einwilligung/Akzeptanz für 2026 ist nicht belegt',
  ELIGIBILITY_2027_NOT_CONFIRMED: 'Voraussetzungen ab 2027 sind nicht bestätigt',
  POSTAL_REQUEST_EFFECT_REQUIRES_REVIEW: 'wirksamer Postantrag erfordert Einzelfallprüfung',
  POSTAL_REQUEST_STATUS_UNKNOWN: 'Postantragsstatus ist unbekannt',
  LEGACY_NOTIFICATION_DATE_UNKNOWN: 'Benachrichtigungstag im Altrecht fehlt',
  LEGACY_NOTIFICATION_ACCESS_DISPUTED: 'Zugang der Altbenachrichtigung ist streitig',
  LEGACY_NOTIFICATION_OUTCOME_NOT_CONFIRMED:
    'Versand der Altbenachrichtigung ist fehlgeschlagen oder nicht bestätigt',
  NOTIFICATION_OUTCOME_UNKNOWN: 'Ergebnis der Benachrichtigung ist unbekannt',
  NOTIFICATION_DUTY_DEVIATION_REQUIRES_SECTION_110_REVIEW:
    'Benachrichtigungsabweichung: Wiedereinsetzung nach § 110 AO prüfen',
};

function diff(actual: { toString(): string } | null, expected: { toString(): string } | null) {
  if (actual === null || expected === null) return null;
  const a = Number(actual.toString());
  const e = Number(expected.toString());
  if (!Number.isFinite(a) || !Number.isFinite(e)) return null;
  return a - e;
}

function AmountDifference({ value }: { value: number | null }) {
  if (value === null) return <span className="text-disabled">—</span>;
  if (value > 0) return <span className="text-red-700">+{fmtEUR(value)}</span>;
  if (value < 0) return <span className="text-emerald-700">{fmtEUR(value)}</span>;
  return <span className="text-muted">±0</span>;
}

function DataRetrievalEvidenceDetails({
  issuedAt,
  notificationDate,
  legacyFallback,
  notificationDisputedOrLate,
  retrievedAt,
  consentStatus,
  eligibility2027Status,
  postalRequestStatus,
  postalRequestReceivedAt,
  notificationStatus,
}: {
  issuedAt: Date | null;
  notificationDate: Date | null;
  legacyFallback: boolean;
  notificationDisputedOrLate: boolean;
  retrievedAt: Date | null;
  consentStatus: string;
  eligibility2027Status: string;
  postalRequestStatus: string;
  postalRequestReceivedAt: Date | null;
  notificationStatus: string;
}) {
  return (
    <>
      {issuedAt && <div className="text-xs text-muted">Erlassen: {fmtDateShort(issuedAt)}</div>}
      {notificationDate && (
        <div className="text-xs text-muted">Benachrichtigung: {fmtDateShort(notificationDate)}</div>
      )}
      {notificationStatus !== 'NOT_RECORDED' && (
        <div className="text-xs text-muted">Benachrichtigungsstatus: {notificationStatus}</div>
      )}
      {consentStatus !== 'NOT_APPLICABLE' && (
        <div className="text-xs text-muted">Einwilligung 2026: {consentStatus}</div>
      )}
      {eligibility2027Status !== 'NOT_APPLICABLE' && (
        <div className="text-xs text-muted">Voraussetzungen ab 2027: {eligibility2027Status}</div>
      )}
      {postalRequestStatus !== 'NOT_APPLICABLE' && (
        <div className="text-xs text-muted">
          Postantrag ab 2027: {postalRequestStatus}
          {postalRequestReceivedAt ? ` (Zugang ${fmtDateShort(postalRequestReceivedAt)})` : ''}
        </div>
      )}
      {legacyFallback && (
        <div className="text-xs text-amber-700">
          Altbestand: Erlass-/Benachrichtigungstag nicht dokumentiert; Frist unverändert übernommen
        </div>
      )}
      {notificationDisputedOrLate && retrievedAt && (
        <div className="text-xs text-amber-700">
          Maßgeblicher Abruf: {fmtDateShort(retrievedAt)}
        </div>
      )}
    </>
  );
}

function CalculatedDeadlineAssessment({
  status,
  appealDeadline,
  manualReviewRequired,
  deadlineDays,
}: {
  status: string;
  appealDeadline: Date | null;
  manualReviewRequired: boolean;
  deadlineDays: number | null;
}) {
  if (status !== 'CALCULATED' || !appealDeadline) return null;
  return (
    <>
      <span
        className={
          manualReviewRequired ? 'text-xs font-medium text-amber-700' : 'text-xs text-muted'
        }
      >
        {manualReviewRequired
          ? 'Kontrollvorschlag – fachliche Freigabe offen'
          : 'Kontrollvorschlag'}
      </span>
      <span
        className={
          deadlineDays !== null && deadlineDays <= 7 ? 'text-red-700 font-medium' : 'text-secondary'
        }
      >
        {fmtDateShort(appealDeadline)}
      </span>
      {deadlineDays !== null && (
        <span className="text-xs text-muted">
          {deadlineDays >= 0 ? `noch ${deadlineDays} Tage` : `${-deadlineDays} Tage abgelaufen`}
        </span>
      )}
    </>
  );
}

function DeadlineAssessment({
  status,
  appealDeadline,
  internalRiskDeadline,
  alternativeClaimedAccessDeadline,
  manualReviewRequired,
  manualReviewReason,
  reinstatementReviewRequired,
  deadlineDays,
}: {
  status: string;
  appealDeadline: Date | null;
  internalRiskDeadline: Date | null;
  alternativeClaimedAccessDeadline: Date | null;
  manualReviewRequired: boolean;
  manualReviewReason: string | null;
  reinstatementReviewRequired: boolean;
  deadlineDays: number | null;
}) {
  const reasons = (manualReviewReason ?? '')
    .split(',')
    .map((reason) => reason.trim())
    .filter(Boolean);

  return (
    <div className="flex flex-col gap-0.5">
      <CalculatedDeadlineAssessment
        status={status}
        appealDeadline={appealDeadline}
        manualReviewRequired={manualReviewRequired}
        deadlineDays={deadlineDays}
      />
      {status === 'LEGACY_UNVERIFIED' && appealDeadline && (
        <>
          <span className="text-xs font-medium text-amber-700">Altbestand – ungeprüfte Frist</span>
          <span className="text-amber-800">{fmtDateShort(appealDeadline)}</span>
        </>
      )}
      {status === 'RISK_ONLY' && internalRiskDeadline && (
        <>
          <span className="text-xs font-medium text-amber-700">
            Interner Risikotermin – keine Rechtsfrist
          </span>
          <span className="text-amber-800">{fmtDateShort(internalRiskDeadline)}</span>
        </>
      )}
      {status === 'MANUAL_REVIEW' && (
        <span className="text-xs font-medium text-amber-700">
          Manuelle Fristprüfung erforderlich
        </span>
      )}
      {status === 'MANUAL_REVIEW' && internalRiskDeadline && (
        <span className="text-xs text-amber-700">
          Szenario gesetzliche Fiktion: {fmtDateShort(internalRiskDeadline)}
        </span>
      )}
      {status === 'MANUAL_REVIEW' && alternativeClaimedAccessDeadline && (
        <span className="text-xs text-amber-700">
          Szenario behaupteter späterer Zugang: {fmtDateShort(alternativeClaimedAccessDeadline)}
        </span>
      )}
      {reasons.map((reason) => (
        <span key={reason} className="text-xs text-amber-700">
          {REVIEW_REASON_LABELS[reason] ?? reason}
        </span>
      ))}
      {reinstatementReviewRequired && (
        <span className="text-xs font-medium text-red-700">
          Wiedereinsetzung nach § 110 AO gesondert prüfen
        </span>
      )}
      {!appealDeadline && !internalRiskDeadline && status === 'LEGACY_UNVERIFIED' && (
        <span className="text-xs text-amber-700">Altbestand fachlich noch nicht beurteilt</span>
      )}
    </div>
  );
}

function PartialReliefEvidence({ receivedAt }: { receivedAt: Date | null }) {
  if (!receivedAt) return null;
  return (
    <div className="text-xs text-muted mt-1">Teilabhilfe bekannt am {fmtDateShort(receivedAt)}</div>
  );
}

function hasCompletePartialReliefEvidence(receivedAt: Date | null, receivedBy: string | null) {
  return Boolean(receivedAt && receivedBy);
}

export default async function ClientNoticesPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } }),
        tx.taxNotice.findMany({
          where: { clientId },
          orderBy: { noticeDate: 'desc' },
          include: {
            document: { select: { id: true, title: true } },
            filing: {
              select: {
                id: true,
                kind: true,
                period: true,
                sharedWithClient: true,
                expectedAssessed: true,
              },
            },
          },
        }),
        tx.taxFiling.findMany({
          where: { clientId },
          orderBy: [{ filingDate: 'desc' }, { createdAt: 'desc' }],
          include: {
            document: { select: { id: true, title: true } },
            notices: { select: { id: true }, take: 1 },
          },
        }),
      ]),
  );
  const [client, notices, filings] = data;
  if (!client) notFound();

  const today = berlinTodayUtcMidnight();

  return (
    <div className="p-8 max-w-6xl">
      <Link href={`/staff/clients/${clientId}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Steuerunterlagen</h1>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
        <Link href={`/staff/clients/${clientId}/notices/new`} className="btn-primary">
          <Plus className="h-4 w-4" />
          Bescheid erfassen
        </Link>
      </div>

      <FilingsSection
        clientId={clientId}
        filings={filings.map((f) => ({
          id: f.id,
          kind: f.kind,
          period: f.period,
          filingDate: f.filingDate,
          expectedAssessed: f.expectedAssessed ? Number(f.expectedAssessed.toString()) : null,
          expectedPrepaid: f.expectedPrepaid ? Number(f.expectedPrepaid.toString()) : null,
          expectedRefund: f.expectedRefund ? Number(f.expectedRefund.toString()) : null,
          expectedPay: f.expectedPay ? Number(f.expectedPay.toString()) : null,
          clientNote: f.clientNote,
          internalNote: f.internalNote,
          sharedWithClient: f.sharedWithClient,
          sharedAt: f.sharedAt,
          document: f.document,
          matchedNoticeId: f.notices[0]?.id ?? null,
        }))}
      />

      <h2 className="text-sm font-medium text-secondary uppercase tracking-wide mb-3">
        Bescheide vom Finanzamt
      </h2>
      {notices.length === 0 ? (
        <div className="card p-10 text-center">
          <FileWarning className="h-10 w-10 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">Keine Bescheide erfasst.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Bescheid
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Ausgangsdatum
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Festgesetzt
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Erwartet
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Δ</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Einspruch bis
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {notices.map((n) => {
                const delta = diff(n.assessedAmount, n.expectedAmount);
                const deadlineDays = n.appealDeadline
                  ? Math.round(
                      (n.appealDeadline.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
                    )
                  : null;
                const klageDeadlineDays = n.klageDeadline
                  ? Math.round(
                      (n.klageDeadline.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
                    )
                  : null;
                const klageFristErledigt = taxNoticeKlageFristErledigt(n.status, {
                  klageDeadline: n.klageDeadline,
                  klageFiledAt: n.klageFiledAt,
                  klageFiledBy: n.klageFiledBy,
                  legalFinalAt: n.legalFinalAt,
                  legalFinalBy: n.legalFinalBy,
                  legalFinalReason: n.legalFinalReason,
                });
                const klageEinreichungDokumentiert = Boolean(n.klageFiledAt && n.klageFiledBy);
                return (
                  <tr key={n.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-primary">
                        {NOTICE_KIND_LABELS[n.kind] ?? n.kind}
                      </div>
                      <div className="text-xs text-muted">
                        {n.period}
                        {n.fileNumber && ` · Az. ${n.fileNumber}`}
                      </div>
                      {n.document && (
                        <Link
                          href={`/api/staff/documents/${n.document.id}/download`}
                          className="text-xs text-brand-700 hover:underline inline-flex items-center gap-1 mt-1"
                        >
                          <FileText className="h-3 w-3" />
                          PDF
                        </Link>
                      )}
                      {n.filing && (
                        <div className="text-xs mt-1 flex items-center gap-1 text-muted">
                          <span>↪ aus Erklärung</span>
                          {n.filing.sharedWithClient && (
                            <span
                              className="badge-green text-xs"
                              title="Mandant sieht die Erklärung im Portal"
                            >
                              Portal
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-secondary">
                      {fmtDateShort(n.noticeDate)}
                      <div className="text-xs text-muted">
                        {DELIVERY_LABELS[n.deliveryMethod] ?? n.deliveryMethod}
                      </div>
                      <div className="text-xs text-muted">
                        {DATE_BASIS_LABELS[n.dateBasis] ?? n.dateBasis}
                      </div>
                      <DataRetrievalEvidenceDetails
                        issuedAt={n.retrievalIssuedAt}
                        notificationDate={n.retrievalNotificationDate}
                        legacyFallback={n.retrievalNotificationLegacyFallback}
                        notificationDisputedOrLate={n.retrievalNotificationDisputedOrLate}
                        retrievedAt={n.retrievedAt}
                        consentStatus={n.retrievalConsentStatus}
                        eligibility2027Status={n.retrievalEligibility2027Status}
                        postalRequestStatus={n.retrievalPostalRequestStatus}
                        postalRequestReceivedAt={n.retrievalPostalRequestReceivedAt}
                        notificationStatus={n.retrievalNotificationStatus}
                      />
                      {n.legalRemedyInstructionStatus === 'UNWIRKSAM' && (
                        <div className="text-xs text-amber-700">
                          Jahresfrist-Kontrollvorschlag (§ 356 Abs. 2 AO)
                        </div>
                      )}
                      {n.legalRemedyInstructionStatus === 'UNKLAR' && (
                        <div className="text-xs text-amber-700">
                          Rechtsbehelfsbelehrung unklar – manuell prüfen
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-primary">{fmtEUR(n.assessedAmount)}</td>
                    <td className="px-4 py-3 font-mono text-secondary">
                      {fmtEUR(n.expectedAmount)}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      <AmountDifference value={delta} />
                    </td>
                    <td className="px-4 py-3">
                      <DeadlineAssessment
                        status={n.deadlineCalculationStatus}
                        appealDeadline={n.appealDeadline}
                        internalRiskDeadline={n.internalRiskDeadline}
                        alternativeClaimedAccessDeadline={n.alternativeClaimedAccessDeadline}
                        manualReviewRequired={n.manualReviewRequired}
                        manualReviewReason={n.manualReviewReason}
                        reinstatementReviewRequired={n.retrievalReinstatementReviewRequired}
                        deadlineDays={deadlineDays}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {n.status === 'NEU' && (
                        <span className="badge-yellow">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status === 'GEPRUEFT' && (
                        <span className="badge-green">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status === 'EINSPRUCH' && (
                        <span className="badge-yellow">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status === 'ABGEHOLFEN' && (
                        <span className="badge-green">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status === 'TEILABHILFE' && (
                        <span className="badge-yellow">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      <PartialReliefEvidence receivedAt={n.partialReliefReceivedAt} />
                      {n.status === 'TEILEINSPRUCHSENTSCHEIDUNG' && (
                        <span className="badge-red">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status === 'ZURUECKGEWIESEN' && (
                        <span className="badge-red">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status === 'KLAGE' && (
                        <span className="badge-red">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status === 'BESTANDSKRAEFTIG' && (
                        <span className="badge-gray">{NOTICE_STATUS_LABELS[n.status]}</span>
                      )}
                      {n.status !== 'TEILABHILFE' && n.appealDecisionReceivedAt && (
                        <div className="text-xs text-muted mt-1">
                          Einspruchsentscheidung bekannt am{' '}
                          {fmtDateShort(n.appealDecisionReceivedAt)}
                        </div>
                      )}
                      {n.status !== 'TEILABHILFE' &&
                        n.appealDecisionLegalRemedyInstructionValid === false && (
                          <div className="text-xs text-amber-700">
                            Jahresfrist wegen Belehrungsmangel (§ 55 Abs. 2 FGO)
                          </div>
                        )}
                      {n.status !== 'TEILABHILFE' && n.klageDeadline && (
                        <div
                          className={`text-xs mt-1 ${
                            n.status === 'ZURUECKGEWIESEN' &&
                            klageDeadlineDays !== null &&
                            klageDeadlineDays <= 7
                              ? 'text-red-700 font-medium'
                              : 'text-muted'
                          }`}
                        >
                          Klagefrist: {fmtDateShort(n.klageDeadline)}
                          {klageFristErledigt && ' · erledigt'}
                          {!klageFristErledigt &&
                            klageEinreichungDokumentiert &&
                            ' · Einreichung dokumentiert, Fristkontrolle offen'}
                          {!klageFristErledigt &&
                            !klageEinreichungDokumentiert &&
                            n.status === 'BESTANDSKRAEFTIG' &&
                            ' · Abschlussnachweis unvollständig'}
                        </div>
                      )}
                      <NoticeStatusSelect
                        noticeId={n.id}
                        currentStatus={n.status}
                        allowed={[...(NOTICE_STATUS_TRANSITIONS[n.status] ?? [])]}
                        evidence={{
                          appealFiledAt: n.appealFiledAt?.toISOString().slice(0, 10) ?? null,
                          appealFiledComplete: Boolean(n.appealFiledAt && n.appealFiledBy),
                          appealResolvedAt: n.appealResolvedAt?.toISOString().slice(0, 10) ?? null,
                          partialReliefReceivedAt:
                            n.partialReliefReceivedAt?.toISOString().slice(0, 10) ?? null,
                          partialReliefComplete: hasCompletePartialReliefEvidence(
                            n.partialReliefReceivedAt,
                            n.partialReliefReceivedBy,
                          ),
                          decisionReceivedAt:
                            n.appealDecisionReceivedAt?.toISOString().slice(0, 10) ?? null,
                          decisionComplete: Boolean(
                            n.appealDecisionReceivedAt &&
                            n.appealDecisionLegalRemedyInstructionValid !== null &&
                            n.klageDeadline,
                          ),
                          decisionInstruction:
                            n.appealDecisionLegalRemedyInstructionValid === false
                              ? 'MISSING_OR_INVALID'
                              : 'VALID',
                          klageFiledAt: n.klageFiledAt?.toISOString().slice(0, 10) ?? null,
                          klageFiledComplete: Boolean(n.klageFiledAt && n.klageFiledBy),
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
