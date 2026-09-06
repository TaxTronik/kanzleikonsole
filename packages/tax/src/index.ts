// =============================================================================
// @taxtronik/tax — Public API
//
// Pure-funktionale Steuertermin-Engine (engine.ts, keine Side-Effects) plus
// der gemeinsame Materialisierungs-Kern (materialize.ts), geteilt zwischen
// Web-App und Worker. DB/Evidence kommen per Dependency-Injection — das
// Paket selbst hat keine Laufzeit-Abhängigkeit auf Prisma oder Evidence
// (nur Typ-Imports).
// =============================================================================

export * from './stbvv/catalog';
export * from './stbvv/calculator';
export * from './screening/core';

export {
  generateDeadlines,
  shiftToNextWorkday,
  germanHolidays,
  berlinCalendarDate,
  berlinTodayUtcMidnight,
  endOfDueDay,
  startOfUtcDay,
  BEKANNTGABE_FIKTION_TAGE,
  bekanntgabeFiktionTage,
  SCHEDULE_LABELS,
  REGION_LABELS,
  type GermanRegion,
  type DeadlineCandidate,
} from './engine';

export {
  materializeTenantTaxDeadlines,
  type MaterializeDb,
  type MaterializeDeps,
  type MaterializeParams,
  type MaterializeStats,
  type AutoRequestEvidence,
  type StaffNotificationInput,
} from './materialize';

export {
  assessWorkdayShift,
  assessAppealDeadline,
  assessDataRetrievalDeadline,
  type WorkdayApplicationType,
  type HolidayCalendarStatus,
  type HolidayLocationContext,
  type WorkdayManualReviewReason,
  type WorkdayShiftAssessment,
  type WorkdayShiftAssessmentInput,
  type LegalRemedyInstructionAssessment,
  type NoticeAccessSituation,
  type AppealDeliveryMethod,
  type AppealManualReviewReason,
  type AppealDeadlineAssessmentInput,
  type AppealDeadlineAssessmentResult,
  type ProvisionEvidenceStatus,
  type Consent2026Status,
  type DataRetrievalEligibility2027Status,
  type PostalRequestStatus,
  type RetrievalNotificationStatus,
  type DataRetrievalManualReviewReason,
  type DataRetrievalDeadlineAssessmentInput,
  type DataRetrievalDeadlineAssessmentResult,
} from './legal-assessments';
