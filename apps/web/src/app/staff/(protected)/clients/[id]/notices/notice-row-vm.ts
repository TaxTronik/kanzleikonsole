// =============================================================================
// Zeilenmodell der Bescheidliste (Review-Befund K-04).
//
// Leitet jede Anzeigeentscheidung einer Bescheidzeile rein aus dem
// gespeicherten Bescheid und dem Berliner Kalendertag ab: Beschriftungen,
// Resttage und Dringlichkeit der Fristen, Status-Badge, Hinweise, Links und
// die Nachweisstände für die Status-Auswahl. Das Modell rechnet KEINE Frist
// neu: Einspruchsfrist, interne Risikotermine, Vergleichsszenarien und
// Prüfgründe kommen unverändert aus dem Datensatz (TAX-NOTICE-APPEAL-001,
// TAX-NOTICE-DATARETRIEVAL-001); ob die Klagefrist erledigt ist, entscheidet
// die zentrale Ableitung des Fristenkontrollbuchs (TAX-CONTROL-STATUS-001).
// =============================================================================

import type { ComponentProps } from 'react';
import { berlinCalendarDate } from '@taxtronik/tax';
import { fmtDateShort, fmtEUR } from '@/lib/fmt';
import { NOTICE_KIND_LABELS, NOTICE_STATUS_LABELS } from '@/lib/domain-labels';
import { taxNoticeKlageFristErledigt } from '@/server/fristen/eintrag';
import type { NoticeStatusSelect } from './status-select';
import { NOTICE_STATUS_TRANSITIONS } from './transitions';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ab so wenigen Resttagen (auch abgelaufen) wird eine Frist rot hervorgehoben. */
const URGENT_DAYS = 7;

export const DELIVERY_LABELS: Record<string, string> = {
  POST: 'Post',
  POST_ABROAD: 'Post ins Ausland',
  ELECTRONIC: 'elektronisch übermittelt',
  DATA_RETRIEVAL: 'zum Datenabruf bereitgestellt',
  FORMAL: 'förmlich zugestellt',
  PERSONAL: 'persönlich übergeben',
  OTHER: 'sonstiger Zugang',
};

export const DATE_BASIS_LABELS: Record<string, string> = {
  LEGACY_UNVERIFIED: 'Altbestand: Datumsbedeutung ungeprüft',
  DISPATCH_DATE: 'nachgewiesener Aufgabe-/Übermittlungstag',
  PROVISION_DATE: 'nachgewiesener Bereitstellungstag',
  ACTUAL_ACCESS_DETERMINED: 'fachlich festgestellter Bekanntgabetag',
  DOCUMENT_DATE_RISK_ONLY: 'Bescheiddatum, nur interner Risikobezug',
};

export const REVIEW_REASON_LABELS: Record<string, string> = {
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

const LEGAL_REMEDY_HINTS: Record<string, string> = {
  UNWIRKSAM: 'Jahresfrist-Kontrollvorschlag (§ 356 Abs. 2 AO)',
  UNKLAR: 'Rechtsbehelfsbelehrung unklar – manuell prüfen',
};

/**
 * Badge je Verfahrensstatus. `beforePartialRelief`: Die Zeile zeigt den
 * Teilabhilfe-Nachweis nach den Badges bis TEILABHILFE und vor denen ab
 * TEILEINSPRUCHSENTSCHEIDUNG (Reihenfolge der bisherigen Darstellung).
 */
const STATUS_BADGES: Record<string, { className: string; beforePartialRelief: boolean }> = {
  NEU: { className: 'badge-yellow', beforePartialRelief: true },
  GEPRUEFT: { className: 'badge-green', beforePartialRelief: true },
  EINSPRUCH: { className: 'badge-yellow', beforePartialRelief: true },
  ABGEHOLFEN: { className: 'badge-green', beforePartialRelief: true },
  TEILABHILFE: { className: 'badge-yellow', beforePartialRelief: true },
  TEILEINSPRUCHSENTSCHEIDUNG: { className: 'badge-red', beforePartialRelief: false },
  ZURUECKGEWIESEN: { className: 'badge-red', beforePartialRelief: false },
  KLAGE: { className: 'badge-red', beforePartialRelief: false },
  BESTANDSKRAEFTIG: { className: 'badge-gray', beforePartialRelief: false },
};

/** Bescheid, wie ihn die Liste lädt (Felder, die die Zeile anzeigt). */
export interface NoticeRowInput {
  id: string;
  kind: string;
  period: string;
  fileNumber: string | null;
  noticeDate: Date;
  deliveryMethod: string;
  dateBasis: string;
  legalRemedyInstructionStatus: string;
  retrievalIssuedAt: Date | null;
  retrievalNotificationDate: Date | null;
  retrievalNotificationLegacyFallback: boolean;
  retrievalNotificationDisputedOrLate: boolean;
  retrievedAt: Date | null;
  retrievalConsentStatus: string;
  retrievalEligibility2027Status: string;
  retrievalPostalRequestStatus: string;
  retrievalPostalRequestReceivedAt: Date | null;
  retrievalNotificationStatus: string;
  retrievalReinstatementReviewRequired: boolean;
  assessedAmount: { toString(): string } | null;
  expectedAmount: { toString(): string } | null;
  deadlineCalculationStatus: string;
  appealDeadline: Date | null;
  internalRiskDeadline: Date | null;
  alternativeClaimedAccessDeadline: Date | null;
  manualReviewRequired: boolean;
  manualReviewReason: string | null;
  status: string;
  appealFiledAt: Date | null;
  appealFiledBy: string | null;
  appealResolvedAt: Date | null;
  partialReliefReceivedAt: Date | null;
  partialReliefReceivedBy: string | null;
  appealDecisionReceivedAt: Date | null;
  appealDecisionLegalRemedyInstructionValid: boolean | null;
  klageDeadline: Date | null;
  klageFiledAt: Date | null;
  klageFiledBy: string | null;
  legalFinalAt: Date | null;
  legalFinalBy: string | null;
  legalFinalReason: string | null;
  document: { id: string } | null;
  filing: { sharedWithClient: boolean } | null;
}

/** Nachweise der Datenabruf-Bekanntgabe (§ 122a AO); `null` = nicht anzeigen. */
export interface RetrievalEvidenceVm {
  issuedAt: string | null;
  notificationDate: string | null;
  notificationStatus: string | null;
  consentStatus: string | null;
  eligibility2027Status: string | null;
  postalRequest: { status: string; receivedSuffix: string } | null;
  legacyFallback: boolean;
  /** Maßgeblicher Abruf, wenn die Benachrichtigung bestritten oder verspätet ist. */
  decisiveRetrieval: string | null;
}

export type AmountDeltaVm =
  | { kind: 'none' }
  | { kind: 'higher'; amount: string }
  | { kind: 'lower'; amount: string }
  | { kind: 'equal' };

export interface DeadlineVm {
  /** Berechneter Kontrollvorschlag (Status CALCULATED mit Einspruchsfrist). */
  calculated: {
    /** Manueller Prüfbedarf offen: Vorschlag ohne fachliche Freigabe. */
    reviewOpen: boolean;
    date: string;
    daysLeft: number;
    daysLabel: string;
    urgent: boolean;
  } | null;
  legacyDate: string | null;
  riskDate: string | null;
  manualReview: boolean;
  fictionScenarioDate: string | null;
  claimedAccessScenarioDate: string | null;
  reasons: Array<{ key: string; label: string }>;
  reinstatementReviewRequired: boolean;
  legacyUnassessed: boolean;
}

export interface KlageDeadlineVm {
  date: string;
  daysLeft: number;
  urgent: boolean;
  /** Erledigung bzw. offener Nachweis, z. B. „ · erledigt“. */
  suffix: string | null;
}

export interface NoticeStatusVm {
  badge: { label: string | undefined; className: string; beforePartialRelief: boolean } | null;
  partialReliefDate: string | null;
  appealDecisionDate: string | null;
  /** Einspruchsentscheidung ohne wirksame Belehrung: Jahresfrist (§ 55 Abs. 2 FGO). */
  decisionInstructionMissing: boolean;
  klage: KlageDeadlineVm | null;
}

type NoticeStatusSelectProps = ComponentProps<typeof NoticeStatusSelect>;

export interface NoticeRowVm {
  id: string;
  kindLabel: string;
  period: string;
  /** „ · Az. …“; leer oder `null`, wenn kein Aktenzeichen erfasst ist. */
  fileNumberSuffix: string | null;
  documentHref: string | null;
  filing: { portalShared: boolean } | null;
  noticeDate: string;
  deliveryLabel: string;
  dateBasisLabel: string;
  retrieval: RetrievalEvidenceVm;
  legalRemedyHint: string | null;
  assessedAmount: string;
  expectedAmount: string;
  delta: AmountDeltaVm;
  deadline: DeadlineVm;
  status: NoticeStatusVm;
  statusSelect: NoticeStatusSelectProps;
}

function dateLabel(date: Date | null): string | null {
  return date ? fmtDateShort(date) : null;
}

/** `YYYY-MM-DD` einer `@db.Date`-Spalte (UTC-Mitternacht). */
function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * `YYYY-MM-DD` eines gespeicherten Verfahrenszeitpunkts: der Berliner Kalendertag,
 * gegen den die Status-Übergänge einen bestätigten Altbestandstag prüfen
 * (TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001).
 */
function eventIsoDay(at: Date | null): string | null {
  return isoDay(at ? berlinCalendarDate(at) : null);
}

/** Ganze Tage vom Berliner Kalendertag `today` bis `date` (negativ = abgelaufen). */
export function daysUntil(date: Date, today: Date): number {
  return Math.round((date.getTime() - today.getTime()) / DAY_MS);
}

function amountValue(value: { toString(): string } | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Abweichung Festsetzung gegenüber Erwartung. */
export function amountDelta(
  assessed: { toString(): string } | null,
  expected: { toString(): string } | null,
): AmountDeltaVm {
  const a = amountValue(assessed);
  const e = amountValue(expected);
  if (a === null || e === null) return { kind: 'none' };
  const delta = a - e;
  if (delta > 0) return { kind: 'higher', amount: fmtEUR(delta) };
  if (delta < 0) return { kind: 'lower', amount: fmtEUR(delta) };
  return { kind: 'equal' };
}

/** Prüfgründe aus der kommagetrennten Speicherung, in gespeicherter Reihenfolge. */
export function reviewReasons(manualReviewReason: string | null): DeadlineVm['reasons'] {
  return (manualReviewReason ?? '')
    .split(',')
    .map((reason) => reason.trim())
    .filter(Boolean)
    .map((reason) => ({ key: reason, label: REVIEW_REASON_LABELS[reason] ?? reason }));
}

function retrievalEvidenceVm(n: NoticeRowInput): RetrievalEvidenceVm {
  return {
    issuedAt: dateLabel(n.retrievalIssuedAt),
    notificationDate: dateLabel(n.retrievalNotificationDate),
    notificationStatus:
      n.retrievalNotificationStatus !== 'NOT_RECORDED' ? n.retrievalNotificationStatus : null,
    consentStatus: n.retrievalConsentStatus !== 'NOT_APPLICABLE' ? n.retrievalConsentStatus : null,
    eligibility2027Status:
      n.retrievalEligibility2027Status !== 'NOT_APPLICABLE'
        ? n.retrievalEligibility2027Status
        : null,
    postalRequest:
      n.retrievalPostalRequestStatus !== 'NOT_APPLICABLE'
        ? {
            status: n.retrievalPostalRequestStatus,
            receivedSuffix: n.retrievalPostalRequestReceivedAt
              ? ` (Zugang ${fmtDateShort(n.retrievalPostalRequestReceivedAt)})`
              : '',
          }
        : null,
    legacyFallback: n.retrievalNotificationLegacyFallback,
    decisiveRetrieval: n.retrievalNotificationDisputedOrLate ? dateLabel(n.retrievedAt) : null,
  };
}

function calculatedDeadlineVm(n: NoticeRowInput, today: Date): DeadlineVm['calculated'] {
  if (n.deadlineCalculationStatus !== 'CALCULATED' || !n.appealDeadline) return null;
  const daysLeft = daysUntil(n.appealDeadline, today);
  return {
    reviewOpen: n.manualReviewRequired,
    date: fmtDateShort(n.appealDeadline),
    daysLeft,
    daysLabel: daysLeft >= 0 ? `noch ${daysLeft} Tage` : `${-daysLeft} Tage abgelaufen`,
    urgent: daysLeft <= URGENT_DAYS,
  };
}

/** Einspruchsfrist-Spalte: Kontrollvorschlag, Altbestand, Risikotermin, manuelle Prüfung. */
export function deadlineVm(n: NoticeRowInput, today: Date): DeadlineVm {
  const status = n.deadlineCalculationStatus;
  const manualReview = status === 'MANUAL_REVIEW';
  return {
    calculated: calculatedDeadlineVm(n, today),
    legacyDate: status === 'LEGACY_UNVERIFIED' ? dateLabel(n.appealDeadline) : null,
    riskDate: status === 'RISK_ONLY' ? dateLabel(n.internalRiskDeadline) : null,
    manualReview,
    fictionScenarioDate: manualReview ? dateLabel(n.internalRiskDeadline) : null,
    claimedAccessScenarioDate: manualReview ? dateLabel(n.alternativeClaimedAccessDeadline) : null,
    reasons: reviewReasons(n.manualReviewReason),
    reinstatementReviewRequired: n.retrievalReinstatementReviewRequired,
    legacyUnassessed:
      !n.appealDeadline && !n.internalRiskDeadline && status === 'LEGACY_UNVERIFIED',
  };
}

function klageSuffix(n: NoticeRowInput): string | null {
  const erledigt = taxNoticeKlageFristErledigt(n.status, {
    klageDeadline: n.klageDeadline,
    klageFiledAt: n.klageFiledAt,
    klageFiledBy: n.klageFiledBy,
    legalFinalAt: n.legalFinalAt,
    legalFinalBy: n.legalFinalBy,
    legalFinalReason: n.legalFinalReason,
  });
  if (erledigt) return ' · erledigt';
  if (n.klageFiledAt && n.klageFiledBy) return ' · Einreichung dokumentiert, Fristkontrolle offen';
  if (n.status === 'BESTANDSKRAEFTIG') return ' · Abschlussnachweis unvollständig';
  return null;
}

/** Klagefrist (§ 47 FGO) — eine Teilabhilfe allein zeigt keine an. */
export function klageDeadlineVm(n: NoticeRowInput, today: Date): KlageDeadlineVm | null {
  if (n.status === 'TEILABHILFE' || !n.klageDeadline) return null;
  const daysLeft = daysUntil(n.klageDeadline, today);
  return {
    date: fmtDateShort(n.klageDeadline),
    daysLeft,
    urgent: n.status === 'ZURUECKGEWIESEN' && daysLeft <= URGENT_DAYS,
    suffix: klageSuffix(n),
  };
}

export function noticeStatusVm(n: NoticeRowInput, today: Date): NoticeStatusVm {
  const badge = STATUS_BADGES[n.status];
  const afterDecision = n.status !== 'TEILABHILFE';
  return {
    badge: badge ? { label: NOTICE_STATUS_LABELS[n.status], ...badge } : null,
    partialReliefDate: dateLabel(n.partialReliefReceivedAt),
    appealDecisionDate: afterDecision ? dateLabel(n.appealDecisionReceivedAt) : null,
    decisionInstructionMissing:
      afterDecision && n.appealDecisionLegalRemedyInstructionValid === false,
    klage: klageDeadlineVm(n, today),
  };
}

/** Nachweisstände, mit denen die Status-Auswahl Altbestände nachfordert. */
export function noticeStatusEvidence(n: NoticeRowInput): NoticeStatusSelectProps['evidence'] {
  return {
    appealFiledAt: eventIsoDay(n.appealFiledAt),
    appealFiledComplete: Boolean(n.appealFiledAt && n.appealFiledBy),
    appealResolvedAt: eventIsoDay(n.appealResolvedAt),
    partialReliefReceivedAt: isoDay(n.partialReliefReceivedAt),
    partialReliefComplete: Boolean(n.partialReliefReceivedAt && n.partialReliefReceivedBy),
    decisionReceivedAt: isoDay(n.appealDecisionReceivedAt),
    decisionComplete: Boolean(
      n.appealDecisionReceivedAt &&
      n.appealDecisionLegalRemedyInstructionValid !== null &&
      n.klageDeadline,
    ),
    decisionInstruction:
      n.appealDecisionLegalRemedyInstructionValid === false ? 'MISSING_OR_INVALID' : 'VALID',
    klageFiledAt: eventIsoDay(n.klageFiledAt),
    klageFiledComplete: Boolean(n.klageFiledAt && n.klageFiledBy),
  };
}

/**
 * Anzeigemodell einer Bescheidzeile. `today` ist der Berliner Kalendertag als
 * UTC-Mitternacht (berlinTodayUtcMidnight), gegen den die Resttage zählen.
 */
export function toNoticeRowVm(n: NoticeRowInput, today: Date): NoticeRowVm {
  return {
    id: n.id,
    kindLabel: NOTICE_KIND_LABELS[n.kind] ?? n.kind,
    period: n.period,
    fileNumberSuffix: n.fileNumber && ` · Az. ${n.fileNumber}`,
    documentHref: n.document ? `/api/staff/documents/${n.document.id}/download` : null,
    filing: n.filing ? { portalShared: n.filing.sharedWithClient } : null,
    noticeDate: fmtDateShort(n.noticeDate),
    deliveryLabel: DELIVERY_LABELS[n.deliveryMethod] ?? n.deliveryMethod,
    dateBasisLabel: DATE_BASIS_LABELS[n.dateBasis] ?? n.dateBasis,
    retrieval: retrievalEvidenceVm(n),
    legalRemedyHint: LEGAL_REMEDY_HINTS[n.legalRemedyInstructionStatus] ?? null,
    assessedAmount: fmtEUR(n.assessedAmount),
    expectedAmount: fmtEUR(n.expectedAmount),
    delta: amountDelta(n.assessedAmount, n.expectedAmount),
    deadline: deadlineVm(n, today),
    status: noticeStatusVm(n, today),
    statusSelect: {
      noticeId: n.id,
      currentStatus: n.status,
      allowed: [...(NOTICE_STATUS_TRANSITIONS[n.status] ?? [])],
      evidence: noticeStatusEvidence(n),
    },
  };
}
