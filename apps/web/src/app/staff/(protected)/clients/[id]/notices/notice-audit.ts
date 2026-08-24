import { createHash } from 'node:crypto';

function recordSha256(resourceId: string, value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ resourceId, value }, (_key, item) =>
        typeof item === 'bigint' ? item.toString() : item,
      ),
    )
    .digest('hex');
}

interface CreatedNoticeAuditRecord {
  id: string;
  clientId: string;
  filingId: string | null;
  deadlineCalculationStatus: string;
  deadlineCalculationVersion: string | null;
  manualReviewRequired: boolean;
  retrievalReinstatementReviewRequired: boolean;
}

/**
 * Positive list for the immutable creation audit. Personal/case facts stay in
 * the Fachobjekt; the fingerprint binds the audit event to the complete row.
 */
export function taxNoticeCreateAudit<T extends CreatedNoticeAuditRecord>(record: T) {
  return {
    clientId: record.clientId,
    filingId: record.filingId,
    deadlineCalculationStatus: record.deadlineCalculationStatus,
    deadlineCalculationVersion: record.deadlineCalculationVersion,
    manualReviewRequired: record.manualReviewRequired,
    reinstatementReviewRequired: record.retrievalReinstatementReviewRequired,
    recordSha256: recordSha256(record.id, record),
  };
}

interface NoticeStatusBeforeAuditRecord {
  status: string;
  appealFiledAt: Date | null;
  appealFiledBy: string | null;
  appealResolvedAt: Date | null;
  appealDecisionReceivedAt: Date | null;
  klageFiledAt: Date | null;
  klageFiledBy: string | null;
}

export function taxNoticeStatusBeforeAudit(record: NoticeStatusBeforeAuditRecord) {
  return {
    status: record.status,
    appealFilingRecorded: Boolean(record.appealFiledAt && record.appealFiledBy),
    appealResolutionRecorded: Boolean(record.appealResolvedAt),
    appealDecisionReceiptRecorded: Boolean(record.appealDecisionReceivedAt),
    klageFilingRecorded: Boolean(record.klageFiledAt && record.klageFiledBy),
  };
}

/**
 * Positive list for status events. Unknown planner fields are deliberately
 * ignored so a future case-text field cannot silently enter the hash-chain.
 */
export function taxNoticeStatusAfterAudit(
  resourceId: string,
  markers: Record<string, unknown>,
  persistedUpdate: unknown,
) {
  return {
    status: markers.status,
    eventDateRecorded: markers.eventDateRecorded,
    partialReliefReceiptRecorded: markers.partialReliefReceiptRecorded,
    klageDeadlineCalculated: markers.klageDeadlineCalculated,
    klageDeadlineReviewReasons: markers.klageDeadlineReviewReasons,
    decisionLegalRemedyInstructionValid: markers.decisionLegalRemedyInstructionValid,
    legalFinalReasonRecorded: markers.legalFinalReasonRecorded,
    legacyEvidenceFieldsConfirmed: markers.legacyEvidenceFieldsConfirmed,
    appealFilingTimeliness: markers.appealFilingTimeliness,
    klageFilingTimeliness: markers.klageFilingTimeliness,
    recordSha256: recordSha256(resourceId, persistedUpdate),
  };
}
