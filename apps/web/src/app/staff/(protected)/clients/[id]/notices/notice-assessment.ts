import {
  assessAppealDeadline,
  assessDataRetrievalDeadline,
  type AppealDeliveryMethod,
  type HolidayLocationContext,
  type LegalRemedyInstructionAssessment,
  type NoticeAccessSituation,
  type GermanRegion,
} from '@taxtronik/tax';

/** Persistierte Engine-/Regelfassung für reproduzierbare Kontrollvorschläge. */
export const NOTICE_DEADLINE_CALCULATION_VERSION = 'tax-legal-assessment/2026-08-23-v1';

export type NoticeDateBasis =
  | 'DISPATCH_DATE'
  | 'PROVISION_DATE'
  | 'ACTUAL_ACCESS_DETERMINED'
  | 'DOCUMENT_DATE_RISK_ONLY';
export type EvidenceStatus = 'CLAIMED' | 'SUBSTANTIATED' | 'PROFESSIONALLY_DETERMINED';
export type AccessStatus =
  | 'UNCONTESTED'
  | 'NOT_RECEIVED_DISPUTED'
  | 'EARLIER_RECEIPT_RECORDED'
  | 'LATER_RECEIPT_CLAIMED'
  | 'LATER_RECEIPT_DETERMINED';
export type InstructionStatus = 'WIRKSAM' | 'UNWIRKSAM' | 'UNKLAR';
export type HolidayContextStatus =
  | 'CONFIRMED_FOR_DATE_AND_LOCATION'
  | 'STATE_LEVEL_ONLY'
  | 'HISTORICAL_UNVERIFIED'
  | 'FOREIGN_UNSUPPORTED'
  | 'UNKNOWN';

export interface NoticeAssessmentInput {
  deliveryMethod: string;
  noticeDate: Date;
  dateBasis: NoticeDateBasis;
  deliveryEvidenceStatus: EvidenceStatus;
  legalRemedyInstructionStatus: InstructionStatus;
  accessStatus: AccessStatus;
  receivedAt: Date | null;
  accessEvidenceStatus: EvidenceStatus | null;
  recipientHolidayContext: HolidayLocationContext;
  authorityHolidayContext: HolidayLocationContext;
  retrieval: {
    issuedAt: Date | null;
    notificationDate: Date | null;
    notificationDisputedOrLate: boolean;
    retrievedAt: Date | null;
    consentStatus: 'NOT_APPLICABLE' | 'CONFIRMED' | 'NOT_GIVEN' | 'UNKNOWN';
    eligibility2027Status: 'NOT_APPLICABLE' | 'CONFIRMED' | 'NOT_MET' | 'UNKNOWN';
    postalRequestStatus: 'NOT_APPLICABLE' | 'NONE_EFFECTIVE' | 'EFFECTIVE' | 'UNKNOWN';
    postalRequestReceivedAt: Date | null;
    notificationStatus: 'NOT_RECORDED' | 'SENT' | 'FAILED' | 'UNKNOWN';
  };
}

export interface NoticeAssessmentResult {
  calculationStatus: 'CALCULATED' | 'MANUAL_REVIEW' | 'RISK_ONLY';
  notificationDate: Date | null;
  appealDeadline: Date | null;
  internalRiskDeadline: Date | null;
  alternativeClaimedAccessDeadline: Date | null;
  manualReviewRequired: boolean;
  manualReviewReasons: string[];
  reinstatementReviewRequired: boolean;
}

/**
 * Bei der Basis ACTUAL_ACCESS_DETERMINED bezeichnen noticeDate und receivedAt
 * denselben fachlich festgestellten Bekanntgabetag. Abweichende Werte wären
 * widersprüchliche Ausgangsdaten und dürfen nicht in eine Fristberechnung
 * einfließen.
 */
export function determinedAccessDateIsConsistent(input: {
  dateBasis: NoticeDateBasis;
  noticeDate: Date;
  receivedAt: Date | null;
}): boolean {
  return (
    input.dateBasis !== 'ACTUAL_ACCESS_DETERMINED' ||
    (input.receivedAt !== null && input.noticeDate.getTime() === input.receivedAt.getTime())
  );
}

function instruction(status: InstructionStatus): LegalRemedyInstructionAssessment {
  if (status === 'WIRKSAM') return 'VALID';
  if (status === 'UNWIRKSAM') return 'INVALID_OR_MISSING';
  return 'UNCLEAR';
}

function evidenceIsUsable(status: EvidenceStatus): boolean {
  return status === 'SUBSTANTIATED' || status === 'PROFESSIONALLY_DETERMINED';
}

function appealMethod(deliveryMethod: string): AppealDeliveryMethod {
  if (deliveryMethod === 'POST') return 'DOMESTIC_POST';
  if (deliveryMethod === 'ELECTRONIC') return 'DIRECT_ELECTRONIC';
  if (deliveryMethod === 'POST_ABROAD') return 'POST_ABROAD';
  return 'DETERMINED_NOTIFICATION';
}

function accessSituation(input: NoticeAssessmentInput): NoticeAccessSituation {
  if (input.accessStatus === 'NOT_RECEIVED_DISPUTED') {
    return { kind: 'NON_RECEIPT_DISPUTED' };
  }
  if (input.accessStatus === 'EARLIER_RECEIPT_RECORDED' && input.receivedAt) {
    return { kind: 'EARLIER_ACCESS_RECORDED', date: input.receivedAt };
  }
  if (input.accessStatus === 'LATER_RECEIPT_CLAIMED' && input.receivedAt) {
    return { kind: 'LATER_ACCESS_CLAIMED', date: input.receivedAt };
  }
  if (
    input.accessStatus === 'LATER_RECEIPT_DETERMINED' &&
    input.receivedAt &&
    input.accessEvidenceStatus === 'PROFESSIONALLY_DETERMINED'
  ) {
    return { kind: 'ACTUAL_ACCESS_DETERMINED', date: input.receivedAt };
  }
  return { kind: 'NO_DEVIATION_REPORTED' };
}

function notificationStatus(
  input: NoticeAssessmentInput,
): 'SAME_DAY_CONFIRMED' | 'FAILED' | 'LATE' | 'UNKNOWN' {
  const status = input.retrieval.notificationStatus;
  if (status === 'FAILED') return 'FAILED';
  if (status !== 'SENT' || !input.retrieval.notificationDate) return 'UNKNOWN';
  return input.retrieval.notificationDate.getTime() === input.noticeDate.getTime()
    ? 'SAME_DAY_CONFIRMED'
    : 'LATE';
}

function assessRetrieval(input: NoticeAssessmentInput): NoticeAssessmentResult {
  const provisionEvidence =
    input.deliveryEvidenceStatus === 'PROFESSIONALLY_DETERMINED'
      ? 'PROFESSIONALLY_DETERMINED'
      : input.deliveryEvidenceStatus === 'SUBSTANTIATED'
        ? 'TECHNICALLY_EVIDENCED'
        : 'CLAIMED';
  const result = assessDataRetrievalDeadline({
    issuedAt: input.retrieval.issuedAt,
    provisionDate: input.noticeDate,
    provisionEvidence,
    legalRemedyInstruction: instruction(input.legalRemedyInstructionStatus),
    notificationHolidayContext: input.recipientHolidayContext,
    deadlineHolidayContext: input.authorityHolidayContext,
    consent2026:
      input.retrieval.consentStatus === 'CONFIRMED'
        ? 'ACTIVE_DOCUMENTED'
        : input.retrieval.consentStatus === 'NOT_GIVEN'
          ? 'ABSENT'
          : 'UNKNOWN',
    eligibility2027:
      input.retrieval.eligibility2027Status === 'CONFIRMED'
        ? 'CONFIRMED'
        : input.retrieval.eligibility2027Status === 'NOT_MET'
          ? 'NOT_MET'
          : 'UNKNOWN',
    postalRequestStatus:
      input.retrieval.postalRequestStatus === 'NONE_EFFECTIVE'
        ? 'NO_EFFECTIVE_REQUEST'
        : input.retrieval.postalRequestStatus === 'EFFECTIVE'
          ? 'EFFECTIVE_REQUEST'
          : 'UNKNOWN',
    postalRequestReceivedAt: input.retrieval.postalRequestReceivedAt,
    notificationStatus: notificationStatus(input),
    legacyNotificationDate: input.retrieval.notificationDate,
    legacyNotificationDisputedOrLate: input.retrieval.notificationDisputedOrLate,
    legacyRetrievedAt: input.retrieval.retrievedAt,
  });

  const calculated = result.status !== 'MANUAL_REVIEW';
  return {
    calculationStatus: calculated ? 'CALCULATED' : 'MANUAL_REVIEW',
    notificationDate: result.notificationDate,
    appealDeadline: result.deadline,
    internalRiskDeadline: calculated ? null : result.controlDeadline,
    alternativeClaimedAccessDeadline: null,
    manualReviewRequired: result.status !== 'CALCULATED',
    manualReviewReasons: result.manualReviewReasons,
    reinstatementReviewRequired: result.reinstatementReviewRequired,
  };
}

type AppealDeadlineAssessment = ReturnType<typeof assessAppealDeadline>;

function assessNonRetrievalDeadline(input: NoticeAssessmentInput): AppealDeadlineAssessment {
  const determinedAccess = input.dateBasis === 'ACTUAL_ACCESS_DETERMINED' ? input.receivedAt : null;
  const dispatchDate =
    input.dateBasis === 'DISPATCH_DATE' && evidenceIsUsable(input.deliveryEvidenceStatus)
      ? input.noticeDate
      : null;

  return assessAppealDeadline({
    deliveryMethod: determinedAccess
      ? 'DETERMINED_NOTIFICATION'
      : appealMethod(input.deliveryMethod),
    dispatchDate,
    determinedNotificationDate: determinedAccess,
    access: determinedAccess ? { kind: 'NO_DEVIATION_REPORTED' } : accessSituation(input),
    riskReferenceDate: input.dateBasis === 'DOCUMENT_DATE_RISK_ONLY' ? input.noticeDate : null,
    legalRemedyInstruction: instruction(input.legalRemedyInstructionStatus),
    notificationHolidayContext: input.recipientHolidayContext,
    deadlineHolidayContext: input.authorityHolidayContext,
  });
}

function additionalManualReviewReasons(
  input: NoticeAssessmentInput,
  result: AppealDeadlineAssessment,
): string[] {
  const reasons: string[] = [];
  if (input.dateBasis === 'DISPATCH_DATE' && !evidenceIsUsable(input.deliveryEvidenceStatus)) {
    reasons.push('DELIVERY_EVIDENCE_INSUFFICIENT');
  }
  if (
    input.accessStatus === 'LATER_RECEIPT_DETERMINED' &&
    input.accessEvidenceStatus !== 'PROFESSIONALLY_DETERMINED'
  ) {
    reasons.push('ACCESS_NOT_PROFESSIONALLY_DETERMINED');
  }
  if (
    input.accessStatus === 'LATER_RECEIPT_DETERMINED' &&
    input.receivedAt &&
    result.notificationWorkdayAssessment?.controlDate &&
    input.receivedAt.getTime() <= result.notificationWorkdayAssessment.controlDate.getTime()
  ) {
    reasons.push('DETERMINED_LATER_ACCESS_NOT_AFTER_FICTION');
  }
  return reasons;
}

function toNoticeAssessmentResult(
  input: NoticeAssessmentInput,
  result: AppealDeadlineAssessment,
  extraReasons: readonly string[],
): NoticeAssessmentResult {
  const reasons = [...new Set([...result.manualReviewReasons, ...extraReasons])];
  const blocked = result.status !== 'CALCULATED' || extraReasons.length > 0;

  return {
    calculationStatus:
      input.dateBasis === 'DOCUMENT_DATE_RISK_ONLY'
        ? 'RISK_ONLY'
        : blocked
          ? 'MANUAL_REVIEW'
          : 'CALCULATED',
    notificationDate: blocked ? null : result.notificationDate,
    appealDeadline: blocked ? null : result.deadline,
    internalRiskDeadline:
      input.dateBasis === 'DOCUMENT_DATE_RISK_ONLY'
        ? result.riskDeadline
        : blocked
          ? result.controlDeadline
          : null,
    alternativeClaimedAccessDeadline: result.claimedAccessControlDeadline,
    manualReviewRequired: blocked,
    manualReviewReasons: reasons,
    reinstatementReviewRequired: false,
  };
}

/**
 * Verbindet die beweisorientierte Tax-Engine mit dem persistierten
 * Bescheidmodell. Ein manueller oder Risikostatus liefert niemals eine
 * scheinbar festgestellte Einspruchsfrist.
 */
export function assessNoticeEvidence(input: NoticeAssessmentInput): NoticeAssessmentResult {
  if (input.deliveryMethod === 'DATA_RETRIEVAL') return assessRetrieval(input);

  const result = assessNonRetrievalDeadline(input);
  return toNoticeAssessmentResult(input, result, additionalManualReviewReasons(input, result));
}

export function holidayContext(input: {
  countryCode: string;
  region: string | null;
  locality: string | null;
  calendarStatus: HolidayContextStatus;
  bavariaAssumptionApplies: boolean | null;
  localHolidays?: readonly Date[];
}): HolidayLocationContext {
  return {
    countryCode: input.countryCode,
    region: input.region as GermanRegion | null,
    locality: input.locality,
    calendarStatus: input.calendarStatus,
    bavariaAssumptionApplies: input.bavariaAssumptionApplies,
    localHolidays: input.localHolidays,
  };
}
