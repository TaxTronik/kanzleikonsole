import {
  bekanntgabeFiktionTage,
  BEKANNTGABE_FIKTION_TAGE,
  germanHolidays,
  startOfUtcDay,
  type GermanRegion,
} from './engine';

const DAY_MS = 24 * 60 * 60 * 1000;

// Fachkatalog: TAX-DEADLINE-WORKDAY-001

/**
 * Fachliche Einordnung vor einer möglichen Verschiebung nach § 108 Abs. 3 AO.
 * Die übrigen Ausprägungen werden absichtlich nicht automatisch verschoben.
 */
export type WorkdayApplicationType =
  | 'STANDARD_DEADLINE_END'
  | 'AUTHORITY_PERFORMANCE_PERIOD'
  | 'AUTHORITY_FIXED_DATE'
  | 'HOURLY_DEADLINE'
  | 'UNCLEAR';

/**
 * Aussage darüber, wie belastbar der vom Aufrufer gelieferte Feiertagskontext
 * für genau das zu prüfende Datum und den maßgeblichen Ort ist.
 */
export type HolidayCalendarStatus =
  | 'CONFIRMED_FOR_DATE_AND_LOCATION'
  | 'STATE_LEVEL_ONLY'
  | 'HISTORICAL_UNVERIFIED'
  | 'FOREIGN_UNSUPPORTED'
  | 'UNKNOWN';

export interface HolidayLocationContext {
  /** ISO-3166-1 Alpha-2. Die Engine kann derzeit ausschließlich DE berechnen. */
  countryCode: string | null;
  /** Bundesland des rechtlich maßgeblichen Orts, nicht der Kanzleisitz. */
  region: GermanRegion | null;
  /** Für CALCULATED erforderlich; örtliche Feiertage werden über localHolidays ergänzt. */
  locality?: string | null;
  calendarStatus: HolidayCalendarStatus;
  /**
   * Gesetzliche örtliche Feiertage, die nicht im Landeskalender enthalten sind.
   * Der Aufrufer bestätigt über calendarStatus, dass die Liste für Ort und Datum
   * vollständig ist.
   */
  localHolidays?: readonly Date[];
  /** Für Bayern muss die örtliche Geltung von Mariä Himmelfahrt explizit feststehen. */
  bavariaAssumptionApplies?: boolean | null;
}

export type WorkdayManualReviewReason =
  | 'AUTHORITY_PERFORMANCE_PERIOD_REQUIRES_SEPARATE_REVIEW'
  | 'AUTHORITY_FIXED_DATE_REQUIRES_SEPARATE_REVIEW'
  | 'HOURLY_DEADLINE_REQUIRES_SEPARATE_REVIEW'
  | 'APPLICATION_TYPE_UNCLEAR'
  | 'HOLIDAY_LOCATION_UNKNOWN'
  | 'HOLIDAY_REGION_UNKNOWN'
  | 'HOLIDAY_LOCALITY_UNKNOWN'
  | 'FOREIGN_HOLIDAY_CALENDAR_UNSUPPORTED'
  | 'LOCAL_HOLIDAY_CALENDAR_INCOMPLETE'
  | 'HISTORICAL_HOLIDAY_CALENDAR_UNVERIFIED'
  | 'HOLIDAY_CALENDAR_UNKNOWN'
  | 'BAVARIA_ASSUMPTION_UNRESOLVED';

export interface WorkdayShiftAssessment {
  status: 'CALCULATED' | 'MANUAL_REVIEW';
  /** Nur bei vollständig automatisierbarem Standardfall gesetzt. */
  date: Date | null;
  /** Sichtbar als technischer Kontrollvorschlag zu behandeln, nie als Feststellung. */
  controlDate: Date;
  shifted: boolean;
  applicationType: WorkdayApplicationType;
  manualReviewReasons: WorkdayManualReviewReason[];
}

export interface WorkdayShiftAssessmentInput {
  date: Date;
  applicationType: WorkdayApplicationType;
  holidayContext: HolidayLocationContext;
}

function dateKey(date: Date): string {
  const normalized = startOfUtcDay(date);
  return `${normalized.getUTCFullYear()}-${normalized.getUTCMonth()}-${normalized.getUTCDate()}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function workdayCandidate(date: Date, context: HolidayLocationContext): Date {
  const start = startOfUtcDay(date);
  // Für einen nichtdeutschen Kalender wäre bereits eine Wochenenddefinition
  // eine fachliche Annahme. Deshalb bleibt der Kontrollwert dort unverändert.
  if (context.countryCode !== 'DE') return start;

  const localHolidayKeys = new Set((context.localHolidays ?? []).map(dateKey));
  const region = context.region;
  // Bei ungeklärter bayerischer Gemeinde wird für den Kontrolltermin die
  // frühere (strengere) Variante ohne Mariä-Himmelfahrt-Verschiebung verwendet.
  const bavariaAssumption = context.bavariaAssumptionApplies ?? false;
  let candidate = start;

  while (true) {
    const weekday = candidate.getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const statutoryHoliday = germanHolidays(
      candidate.getUTCFullYear(),
      region,
      bavariaAssumption,
    ).some((holiday) => dateKey(holiday) === dateKey(candidate));
    if (!weekend && !statutoryHoliday && !localHolidayKeys.has(dateKey(candidate))) break;
    candidate = new Date(candidate.getTime() + DAY_MS);
  }

  return candidate;
}

const WORKDAY_APPLICATION_REVIEW_REASON: Partial<
  Record<WorkdayApplicationType, WorkdayManualReviewReason>
> = {
  AUTHORITY_PERFORMANCE_PERIOD: 'AUTHORITY_PERFORMANCE_PERIOD_REQUIRES_SEPARATE_REVIEW',
  AUTHORITY_FIXED_DATE: 'AUTHORITY_FIXED_DATE_REQUIRES_SEPARATE_REVIEW',
  HOURLY_DEADLINE: 'HOURLY_DEADLINE_REQUIRES_SEPARATE_REVIEW',
  UNCLEAR: 'APPLICATION_TYPE_UNCLEAR',
};

const HOLIDAY_CALENDAR_REVIEW_REASON: Partial<
  Record<HolidayCalendarStatus, WorkdayManualReviewReason>
> = {
  STATE_LEVEL_ONLY: 'LOCAL_HOLIDAY_CALENDAR_INCOMPLETE',
  HISTORICAL_UNVERIFIED: 'HISTORICAL_HOLIDAY_CALENDAR_UNVERIFIED',
  FOREIGN_UNSUPPORTED: 'FOREIGN_HOLIDAY_CALENDAR_UNSUPPORTED',
  UNKNOWN: 'HOLIDAY_CALENDAR_UNKNOWN',
};

function holidayContextReviewReasons(context: HolidayLocationContext): WorkdayManualReviewReason[] {
  const reasons: WorkdayManualReviewReason[] = [];

  if (!context.countryCode) reasons.push('HOLIDAY_LOCATION_UNKNOWN');
  else if (context.countryCode !== 'DE') reasons.push('FOREIGN_HOLIDAY_CALENDAR_UNSUPPORTED');
  if (context.countryCode === 'DE' && !context.region) reasons.push('HOLIDAY_REGION_UNKNOWN');
  if (context.countryCode === 'DE' && (context.locality?.trim().length ?? 0) < 2) {
    reasons.push('HOLIDAY_LOCALITY_UNKNOWN');
  }

  const calendarReason = HOLIDAY_CALENDAR_REVIEW_REASON[context.calendarStatus];
  if (calendarReason) reasons.push(calendarReason);

  if (
    context.countryCode === 'DE' &&
    context.region === 'DE-BY' &&
    context.bavariaAssumptionApplies == null
  ) {
    reasons.push('BAVARIA_ASSUMPTION_UNRESOLVED');
  }

  return unique(reasons);
}

/**
 * Prüft Anwendbarkeit und Feiertagskontext vor der kalendarischen Verschiebung.
 * Anders als shiftToNextWorkday gibt diese API bei unvollständigem Kontext kein
 * scheinbar abschließendes Rechtsdatum zurück.
 */
export function assessWorkdayShift(input: WorkdayShiftAssessmentInput): WorkdayShiftAssessment {
  const original = startOfUtcDay(input.date);

  // § 108 Abs. 4 bis 6 AO wird nicht durch einen unverbindlichen Shift
  // vorweggenommen. Der Kontrollwert bleibt in diesen Fällen das Eingabedatum.
  if (input.applicationType !== 'STANDARD_DEADLINE_END') {
    const reason = WORKDAY_APPLICATION_REVIEW_REASON[input.applicationType];
    return {
      status: 'MANUAL_REVIEW',
      date: null,
      controlDate: original,
      shifted: false,
      applicationType: input.applicationType,
      manualReviewReasons: reason ? [reason] : [],
    };
  }

  const context = input.holidayContext;
  const controlDate = workdayCandidate(original, context);
  const manualReviewReasons = holidayContextReviewReasons(context);
  const calculated = manualReviewReasons.length === 0;
  return {
    status: calculated ? 'CALCULATED' : 'MANUAL_REVIEW',
    date: calculated ? controlDate : null,
    controlDate,
    shifted: controlDate.getTime() !== original.getTime(),
    applicationType: input.applicationType,
    manualReviewReasons,
  };
}

// Fachkatalog: TAX-NOTICE-APPEAL-001

export type LegalRemedyInstructionAssessment = 'VALID' | 'INVALID_OR_MISSING' | 'UNCLEAR';

export type NoticeAccessSituation =
  | { kind: 'NO_DEVIATION_REPORTED' }
  | { kind: 'NON_RECEIPT_DISPUTED' }
  | { kind: 'EARLIER_ACCESS_RECORDED'; date: Date }
  | { kind: 'LATER_ACCESS_CLAIMED'; date: Date }
  | { kind: 'ACTUAL_ACCESS_DETERMINED'; date: Date };

export type AppealDeliveryMethod =
  | 'DOMESTIC_POST'
  | 'DIRECT_ELECTRONIC'
  | 'POST_ABROAD'
  | 'DETERMINED_NOTIFICATION';

export type AppealManualReviewReason =
  | 'DISPATCH_DATE_UNKNOWN'
  | 'DETERMINED_NOTIFICATION_DATE_MISSING'
  | 'NON_RECEIPT_REQUIRES_EVIDENCE_REVIEW'
  | 'RECORDED_EARLIER_ACCESS_AFTER_FICTION'
  | 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW'
  | 'CLAIMED_LATER_ACCESS_NOT_AFTER_FICTION'
  | 'LEGAL_REMEDY_INSTRUCTION_UNCLEAR'
  | 'NOTIFICATION_WORKDAY_REVIEW_REQUIRED'
  | 'DEADLINE_WORKDAY_REVIEW_REQUIRED'
  | 'RISK_DATE_ONLY';

export interface AppealDeadlineAssessmentInput {
  deliveryMethod: AppealDeliveryMethod;
  /** Nachgewiesener Aufgabe- oder Übermittlungstag, nicht das Bescheiddatum. */
  dispatchDate?: Date | null;
  /** Bereits anderweitig fachlich festgestellter Bekanntgabetag. */
  determinedNotificationDate?: Date | null;
  access?: NoticeAccessSituation;
  /** Bescheiddatum o. Ä. ausschließlich für einen markierten internen Risikotermin. */
  riskReferenceDate?: Date | null;
  legalRemedyInstruction: LegalRemedyInstructionAssessment;
  /** Regelmäßig der Ort des Empfängers/Empfangsbevollmächtigten. */
  notificationHolidayContext: HolidayLocationContext;
  /** Regelmäßig der Sitz der zuständigen Finanzbehörde. */
  deadlineHolidayContext: HolidayLocationContext;
}

export interface AppealDeadlineAssessmentResult {
  status: 'CALCULATED' | 'MANUAL_REVIEW' | 'RISK_ONLY';
  /** Fachlich ausreichend bestimmter Bekanntgabetag. */
  notificationDate: Date | null;
  /** Fachlich ausreichend bestimmter Kontrollvorschlag für die Einspruchsfrist. */
  deadline: Date | null;
  /** Technische Zwischenrechnung; bei MANUAL_REVIEW nicht als Feststellung ausgeben. */
  controlNotificationDate: Date | null;
  /** Frühester technischer Kontrollwert aus den verfügbaren Angaben. */
  controlDeadline: Date | null;
  /** Nur Vergleichsszenario für einen behaupteten späteren Zugang. */
  claimedAccessControlDeadline: Date | null;
  /** Nur bei ausdrücklicher riskReferenceDate und fehlendem Ausgangsnachweis. */
  riskDeadline: Date | null;
  manualReviewReasons: AppealManualReviewReason[];
  notificationWorkdayAssessment: WorkdayShiftAssessment | null;
  deadlineWorkdayAssessment: WorkdayShiftAssessment | null;
}

function addCalendarDays(date: Date, days: number): Date {
  const normalized = startOfUtcDay(date);
  return new Date(
    Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth(), normalized.getUTCDate() + days),
  );
}

function addCalendarMonth(date: Date): Date {
  const start = startOfUtcDay(date);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  let result = new Date(Date.UTC(year, month + 1, day));
  if (result.getUTCMonth() !== (month + 1) % 12) {
    result = new Date(Date.UTC(year, month + 2, 0));
  }
  return result;
}

function addCalendarYear(date: Date): Date {
  const start = startOfUtcDay(date);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  let result = new Date(Date.UTC(year + 1, month, day));
  if (result.getUTCMonth() !== month) {
    result = new Date(Date.UTC(year + 1, month + 1, 0));
  }
  return result;
}

function assessStandardWorkday(
  date: Date,
  holidayContext: HolidayLocationContext,
): WorkdayShiftAssessment {
  return assessWorkdayShift({
    date,
    applicationType: 'STANDARD_DEADLINE_END',
    holidayContext,
  });
}

function assessPeriodEnd(
  notificationDate: Date,
  instruction: LegalRemedyInstructionAssessment,
  context: HolidayLocationContext,
): WorkdayShiftAssessment {
  // Bei unklarer Belehrung ist der Ein-Monats-Termin nur der frühere interne
  // Kontrollwert; die Funktion, die das Ergebnis zusammensetzt, blockiert ihn.
  const unshifted =
    instruction === 'INVALID_OR_MISSING'
      ? addCalendarYear(notificationDate)
      : addCalendarMonth(notificationDate);
  return assessStandardWorkday(unshifted, context);
}

function assessFictionDate(
  sourceDate: Date,
  deliveryMethod: Exclude<AppealDeliveryMethod, 'DETERMINED_NOTIFICATION'>,
  context: HolidayLocationContext,
): WorkdayShiftAssessment {
  const unshifted =
    deliveryMethod === 'POST_ABROAD'
      ? addCalendarMonth(sourceDate)
      : addCalendarDays(sourceDate, bekanntgabeFiktionTage(sourceDate));
  return assessStandardWorkday(unshifted, context);
}

type DeadlineManualReviewReason =
  | 'LEGAL_REMEDY_INSTRUCTION_UNCLEAR'
  | 'DEADLINE_WORKDAY_REVIEW_REQUIRED';

interface NotificationDeadlineResolution {
  deadline: Date | null;
  controlDeadline: Date | null;
  deadlineBlocked: boolean;
  reasons: DeadlineManualReviewReason[];
  deadlineWorkdayAssessment: WorkdayShiftAssessment | null;
}

function assessNotificationDeadline(
  notificationDate: Date | null,
  controlNotificationDate: Date | null,
  notificationBlocked: boolean,
  instruction: LegalRemedyInstructionAssessment,
  context: HolidayLocationContext,
): NotificationDeadlineResolution {
  const reasons: DeadlineManualReviewReason[] = [];
  let deadlineBlocked = false;
  let deadline: Date | null = null;
  let controlDeadline: Date | null = null;
  let deadlineWorkdayAssessment: WorkdayShiftAssessment | null = null;

  if (instruction === 'UNCLEAR') {
    reasons.push('LEGAL_REMEDY_INSTRUCTION_UNCLEAR');
    deadlineBlocked = true;
  }

  if (controlNotificationDate) {
    deadlineWorkdayAssessment = assessPeriodEnd(controlNotificationDate, instruction, context);
    controlDeadline = deadlineWorkdayAssessment.controlDate;
    if (!deadlineWorkdayAssessment.date) {
      reasons.push('DEADLINE_WORKDAY_REVIEW_REQUIRED');
      deadlineBlocked = true;
    }
  }

  if (notificationDate && !notificationBlocked && !deadlineBlocked) {
    // Bei einem festgestellten späteren Zugang kann der zuvor berechnete
    // Kontrollwert abweichen; deshalb Fristende aus dem Rechtsdatum neu bilden.
    deadlineWorkdayAssessment = assessPeriodEnd(notificationDate, instruction, context);
    controlDeadline = deadlineWorkdayAssessment.controlDate;
    if (deadlineWorkdayAssessment.date) deadline = deadlineWorkdayAssessment.date;
    else {
      reasons.push('DEADLINE_WORKDAY_REVIEW_REQUIRED');
      deadlineBlocked = true;
    }
  }

  return {
    deadline,
    controlDeadline,
    deadlineBlocked,
    reasons,
    deadlineWorkdayAssessment,
  };
}

interface AppealNotificationResolution {
  reasons: AppealManualReviewReason[];
  notificationBlocked: boolean;
  riskOnly: boolean;
  notificationDate: Date | null;
  controlNotificationDate: Date | null;
  riskNotificationDate: Date | null;
  notificationWorkdayAssessment: WorkdayShiftAssessment | null;
}

function resolveAppealNotificationSource(
  input: AppealDeadlineAssessmentInput,
  access: NoticeAccessSituation,
): AppealNotificationResolution {
  const resolution: AppealNotificationResolution = {
    reasons: [],
    notificationBlocked: false,
    riskOnly: false,
    notificationDate: null,
    controlNotificationDate: null,
    riskNotificationDate: null,
    notificationWorkdayAssessment: null,
  };

  if (input.deliveryMethod === 'DETERMINED_NOTIFICATION') {
    if (input.determinedNotificationDate) {
      resolution.notificationDate = startOfUtcDay(input.determinedNotificationDate);
      resolution.controlNotificationDate = resolution.notificationDate;
    } else {
      resolution.reasons.push('DETERMINED_NOTIFICATION_DATE_MISSING');
      resolution.notificationBlocked = true;
    }
    return resolution;
  }

  if (input.dispatchDate) {
    resolution.notificationWorkdayAssessment = assessFictionDate(
      input.dispatchDate,
      input.deliveryMethod,
      input.notificationHolidayContext,
    );
    resolution.controlNotificationDate = resolution.notificationWorkdayAssessment.controlDate;
    if (resolution.notificationWorkdayAssessment.date) {
      resolution.notificationDate = resolution.notificationWorkdayAssessment.date;
    } else {
      resolution.reasons.push('NOTIFICATION_WORKDAY_REVIEW_REQUIRED');
      resolution.notificationBlocked = true;
    }
    return resolution;
  }

  if (access.kind === 'ACTUAL_ACCESS_DETERMINED') {
    // Ein unabhängig festgestellter tatsächlicher Zugang ist bei unbekanntem
    // Versandtag der einzige automatisch verwertbare Ausgangstag.
    resolution.notificationDate = startOfUtcDay(access.date);
    resolution.controlNotificationDate = resolution.notificationDate;
    return resolution;
  }

  resolution.reasons.push('DISPATCH_DATE_UNKNOWN');
  resolution.notificationBlocked = true;
  if (input.riskReferenceDate) {
    resolution.notificationWorkdayAssessment = assessFictionDate(
      input.riskReferenceDate,
      input.deliveryMethod,
      input.notificationHolidayContext,
    );
    resolution.riskNotificationDate = resolution.notificationWorkdayAssessment.controlDate;
    resolution.controlNotificationDate = resolution.riskNotificationDate;
    resolution.reasons.push('RISK_DATE_ONLY');
    resolution.riskOnly = true;
  }

  return resolution;
}

function applyAppealAccess(
  source: AppealNotificationResolution,
  access: NoticeAccessSituation,
): AppealNotificationResolution {
  const resolution = { ...source, reasons: [...source.reasons] };

  switch (access.kind) {
    case 'NO_DEVIATION_REPORTED':
      break;
    case 'NON_RECEIPT_DISPUTED':
      resolution.reasons.push('NON_RECEIPT_REQUIRES_EVIDENCE_REVIEW');
      resolution.notificationDate = null;
      resolution.notificationBlocked = true;
      break;
    case 'EARLIER_ACCESS_RECORDED': {
      const actual = startOfUtcDay(access.date);
      // Ein früher tatsächlicher Eingang verkürzt die Bekanntgabefiktion nicht.
      // Ist der als „früher“ erfasste Tag tatsächlich später, wird die
      // widersprüchliche Einordnung nicht stillschweigend verwertet.
      if (resolution.notificationDate && actual.getTime() > resolution.notificationDate.getTime()) {
        resolution.reasons.push('RECORDED_EARLIER_ACCESS_AFTER_FICTION');
        resolution.notificationDate = null;
        resolution.notificationBlocked = true;
      }
      break;
    }
    case 'LATER_ACCESS_CLAIMED': {
      const claimed = startOfUtcDay(access.date);
      resolution.reasons.push(
        resolution.controlNotificationDate &&
          claimed.getTime() <= resolution.controlNotificationDate.getTime()
          ? 'CLAIMED_LATER_ACCESS_NOT_AFTER_FICTION'
          : 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW',
      );
      resolution.notificationDate = null;
      resolution.notificationBlocked = true;
      break;
    }
    case 'ACTUAL_ACCESS_DETERMINED': {
      const actual = startOfUtcDay(access.date);
      if (
        !resolution.notificationDate ||
        actual.getTime() > resolution.notificationDate.getTime()
      ) {
        resolution.notificationDate = actual;
      }
      // Ein früher Zugang verkürzt die Fiktion nicht. Der Kontrolltag folgt
      // deshalb ebenfalls nur einem tatsächlich späteren Zugang.
      if (
        !resolution.controlNotificationDate ||
        actual.getTime() > resolution.controlNotificationDate.getTime()
      ) {
        resolution.controlNotificationDate = actual;
      }
      break;
    }
  }

  return resolution;
}

function assessClaimedAccessControlDeadline(
  access: NoticeAccessSituation,
  controlNotificationDate: Date | null,
  instruction: LegalRemedyInstructionAssessment,
  context: HolidayLocationContext,
): Date | null {
  if (access.kind !== 'LATER_ACCESS_CLAIMED') return null;

  const claimed = startOfUtcDay(access.date);
  if (controlNotificationDate && claimed.getTime() <= controlNotificationDate.getTime()) {
    return null;
  }

  // Beide Szenarien bleiben sichtbar: der reguläre Kontrollwert bildet die
  // gesetzliche Fiktion ab, dieser Wert nur die behauptete spätere Variante.
  return assessPeriodEnd(access.date, instruction, context).controlDate;
}

/**
 * Beweisorientierte Einspruchsfristberechnung. Unbekannte Versanddaten werden
 * nicht aus dem Bescheiddatum ersetzt; ein solcher Wert kann nur explizit als
 * riskReferenceDate in die getrennte Risikorechnung eingehen.
 */
export function assessAppealDeadline(
  input: AppealDeadlineAssessmentInput,
): AppealDeadlineAssessmentResult {
  const access = input.access ?? { kind: 'NO_DEVIATION_REPORTED' as const };
  const notification = applyAppealAccess(resolveAppealNotificationSource(input, access), access);
  const deadline = assessNotificationDeadline(
    notification.notificationDate,
    notification.controlNotificationDate,
    notification.notificationBlocked,
    input.legalRemedyInstruction,
    input.deadlineHolidayContext,
  );
  const claimedAccessControlDeadline = assessClaimedAccessControlDeadline(
    access,
    notification.controlNotificationDate,
    input.legalRemedyInstruction,
    input.deadlineHolidayContext,
  );
  const riskDeadline =
    notification.riskNotificationDate && deadline.controlDeadline ? deadline.controlDeadline : null;
  const manualReviewReasons = unique([...notification.reasons, ...deadline.reasons]);

  return {
    status: notification.riskOnly
      ? 'RISK_ONLY'
      : manualReviewReasons.length > 0
        ? 'MANUAL_REVIEW'
        : 'CALCULATED',
    notificationDate: notification.notificationBlocked ? null : notification.notificationDate,
    deadline:
      notification.notificationBlocked || deadline.deadlineBlocked ? null : deadline.deadline,
    controlNotificationDate: notification.controlNotificationDate,
    controlDeadline: deadline.controlDeadline,
    claimedAccessControlDeadline,
    riskDeadline,
    manualReviewReasons,
    notificationWorkdayAssessment: notification.notificationWorkdayAssessment,
    deadlineWorkdayAssessment: deadline.deadlineWorkdayAssessment,
  };
}

// Fachkatalog: TAX-NOTICE-DATARETRIEVAL-001

export type ProvisionEvidenceStatus =
  | 'TECHNICALLY_EVIDENCED'
  | 'PROFESSIONALLY_DETERMINED'
  | 'CLAIMED'
  | 'UNKNOWN';

export type Consent2026Status = 'ACTIVE_DOCUMENTED' | 'ABSENT' | 'UNKNOWN';
export type DataRetrievalEligibility2027Status = 'CONFIRMED' | 'NOT_MET' | 'UNKNOWN';
export type PostalRequestStatus = 'NO_EFFECTIVE_REQUEST' | 'EFFECTIVE_REQUEST' | 'UNKNOWN';
export type RetrievalNotificationStatus =
  | 'SAME_DAY_CONFIRMED'
  | 'FAILED'
  | 'NOT_RECEIVED'
  | 'LATE'
  | 'UNKNOWN';

export type DataRetrievalManualReviewReason =
  | 'ISSUED_AT_UNKNOWN'
  | 'PROVISION_DATE_UNKNOWN'
  | 'PROVISION_NOT_SUFFICIENTLY_EVIDENCED'
  | 'PROVISION_PROFESSIONAL_APPROVAL_PENDING'
  | 'ACTIVE_CONSENT_2026_NOT_DOCUMENTED'
  | 'ELIGIBILITY_2027_NOT_CONFIRMED'
  | 'POSTAL_REQUEST_EFFECT_REQUIRES_REVIEW'
  | 'POSTAL_REQUEST_STATUS_UNKNOWN'
  | 'LEGACY_NOTIFICATION_DATE_UNKNOWN'
  | 'LEGACY_NOTIFICATION_ACCESS_DISPUTED'
  | 'LEGACY_NOTIFICATION_OUTCOME_NOT_CONFIRMED'
  | 'NOTIFICATION_WORKDAY_REVIEW_REQUIRED'
  | 'DEADLINE_WORKDAY_REVIEW_REQUIRED'
  | 'LEGAL_REMEDY_INSTRUCTION_UNCLEAR'
  | 'NOTIFICATION_OUTCOME_UNKNOWN'
  | 'NOTIFICATION_DUTY_DEVIATION_REQUIRES_SECTION_110_REVIEW';

export interface DataRetrievalDeadlineAssessmentInput {
  issuedAt: Date | null;
  provisionDate: Date | null;
  provisionEvidence: ProvisionEvidenceStatus;
  legalRemedyInstruction: LegalRemedyInstructionAssessment;
  notificationHolidayContext: HolidayLocationContext;
  deadlineHolidayContext: HolidayLocationContext;
  /** Für Verwaltungsakte mit Erlassdatum im Kalenderjahr 2026. */
  consent2026?: Consent2026Status;
  /** Für Verwaltungsakte mit Erlassdatum ab 2027. */
  eligibility2027?: DataRetrievalEligibility2027Status;
  /** Für Verwaltungsakte mit Erlassdatum ab 2027. */
  postalRequestStatus?: PostalRequestStatus;
  /** Zugang des Postantrags; seine Wirkung für den konkreten Bescheid richtet sich nach der Bereitstellung. */
  postalRequestReceivedAt?: Date | null;
  /** Ergebnis der gesetzlichen Same-Day-Benachrichtigung im Neurecht. */
  notificationStatus?: RetrievalNotificationStatus;
  /** Altrechtlicher Versandtag der Benachrichtigung (Erlass bis 31.12.2025). */
  legacyNotificationDate?: Date | null;
  legacyNotificationDisputedOrLate?: boolean;
  legacyRetrievedAt?: Date | null;
}

export interface DataRetrievalDeadlineAssessmentResult {
  status: 'CALCULATED' | 'CALCULATED_WITH_REVIEW' | 'MANUAL_REVIEW';
  regime: 'LEGACY_UNTIL_2025' | 'CONSENT_2026' | 'DEFAULT_FROM_2027' | 'UNKNOWN';
  notificationDate: Date | null;
  deadline: Date | null;
  controlNotificationDate: Date | null;
  controlDeadline: Date | null;
  manualReviewReasons: DataRetrievalManualReviewReason[];
  reinstatementReviewRequired: boolean;
  notificationDutyDeviation: boolean;
  notificationWorkdayAssessment: WorkdayShiftAssessment | null;
  deadlineWorkdayAssessment: WorkdayShiftAssessment | null;
}

interface DataRetrievalPrerequisiteResolution {
  reasons: DataRetrievalManualReviewReason[];
  notificationBlocked: boolean;
}

function assessDataRetrievalPrerequisites(
  input: DataRetrievalDeadlineAssessmentInput,
  issuedAt: Date | null,
  provisionDate: Date | null,
): DataRetrievalPrerequisiteResolution {
  const reasons: DataRetrievalManualReviewReason[] = [];
  let notificationBlocked = false;

  if (!issuedAt) {
    reasons.push('ISSUED_AT_UNKNOWN');
    notificationBlocked = true;
  }
  if (!provisionDate) {
    reasons.push('PROVISION_DATE_UNKNOWN');
    notificationBlocked = true;
  }
  if (
    input.provisionEvidence !== 'TECHNICALLY_EVIDENCED' &&
    input.provisionEvidence !== 'PROFESSIONALLY_DETERMINED'
  ) {
    reasons.push('PROVISION_NOT_SUFFICIENTLY_EVIDENCED');
    notificationBlocked = true;
  } else if (input.provisionEvidence === 'TECHNICALLY_EVIDENCED') {
    // Der technische Nachweis trägt die Rechnung, ersetzt aber nicht die im
    // Fachkatalog verlangte fachliche Freigabe des Bekanntgabewegs.
    reasons.push('PROVISION_PROFESSIONAL_APPROVAL_PENDING');
  }

  return { reasons, notificationBlocked };
}

interface DataRetrievalNotificationResolution {
  regime: DataRetrievalDeadlineAssessmentResult['regime'];
  reasons: DataRetrievalManualReviewReason[];
  notificationBlocked: boolean;
  notificationDate: Date | null;
  controlNotificationDate: Date | null;
  notificationWorkdayAssessment: WorkdayShiftAssessment | null;
  reinstatementReviewRequired: boolean;
  notificationDutyDeviation: boolean;
}

function resolveLegacyDataRetrievalNotification(
  input: DataRetrievalDeadlineAssessmentInput,
  provisionDate: Date | null,
): DataRetrievalNotificationResolution {
  const resolution: DataRetrievalNotificationResolution = {
    regime: 'LEGACY_UNTIL_2025',
    reasons: [],
    notificationBlocked: false,
    notificationDate: null,
    controlNotificationDate: null,
    notificationWorkdayAssessment: null,
    reinstatementReviewRequired: false,
    notificationDutyDeviation: false,
  };

  if (input.legacyNotificationDisputedOrLate) {
    if (input.legacyRetrievedAt) {
      resolution.notificationDate = startOfUtcDay(input.legacyRetrievedAt);
      resolution.controlNotificationDate = resolution.notificationDate;
    } else {
      resolution.reasons.push('LEGACY_NOTIFICATION_ACCESS_DISPUTED');
      resolution.notificationBlocked = true;
    }
    return resolution;
  }

  if (
    !input.notificationStatus ||
    ['FAILED', 'NOT_RECEIVED', 'UNKNOWN'].includes(input.notificationStatus)
  ) {
    // Im Altrecht ist die Benachrichtigung selbst der Ausgangsvorgang.
    // Ein bloß eingetragenes Datum darf einen fehlgeschlagenen oder
    // unklaren Versand nicht in einen nachgewiesenen Versand umdeuten.
    resolution.reasons.push('LEGACY_NOTIFICATION_OUTCOME_NOT_CONFIRMED');
    resolution.notificationBlocked = true;
    return resolution;
  }

  if (!input.legacyNotificationDate) {
    resolution.reasons.push('LEGACY_NOTIFICATION_DATE_UNKNOWN');
    resolution.notificationBlocked = true;
    return resolution;
  }

  if (!provisionDate) return resolution;

  const notificationSent = startOfUtcDay(input.legacyNotificationDate);
  resolution.notificationWorkdayAssessment = assessStandardWorkday(
    // Art. 97 § 1 Abs. 15 EGAO knüpft den Wechsel von drei auf vier
    // Tage bei § 122a Abs. 4 AO an die elektronische Bereitstellung,
    // nicht an den gegebenenfalls späteren Benachrichtigungsversand.
    addCalendarDays(notificationSent, bekanntgabeFiktionTage(provisionDate)),
    input.notificationHolidayContext,
  );
  resolution.controlNotificationDate = resolution.notificationWorkdayAssessment.controlDate;
  if (resolution.notificationWorkdayAssessment.date) {
    resolution.notificationDate = resolution.notificationWorkdayAssessment.date;
  } else {
    resolution.reasons.push('NOTIFICATION_WORKDAY_REVIEW_REQUIRED');
    resolution.notificationBlocked = true;
  }

  return resolution;
}

interface ModernDataRetrievalRequirements {
  regime: Extract<
    DataRetrievalDeadlineAssessmentResult['regime'],
    'CONSENT_2026' | 'DEFAULT_FROM_2027'
  >;
  reasons: DataRetrievalManualReviewReason[];
  notificationBlocked: boolean;
  reinstatementReviewRequired: boolean;
}

function assessModernDataRetrievalRequirements(
  input: DataRetrievalDeadlineAssessmentInput,
  issuedYear: number,
  provisionDate: Date | null,
): ModernDataRetrievalRequirements {
  const reasons: DataRetrievalManualReviewReason[] = [];
  let notificationBlocked = false;
  let reinstatementReviewRequired = false;

  if (issuedYear === 2026) {
    if (input.consent2026 !== 'ACTIVE_DOCUMENTED') {
      reasons.push('ACTIVE_CONSENT_2026_NOT_DOCUMENTED');
      notificationBlocked = true;
    }
    return {
      regime: 'CONSENT_2026',
      reasons,
      notificationBlocked,
      reinstatementReviewRequired,
    };
  }

  if (input.eligibility2027 !== 'CONFIRMED') {
    reasons.push('ELIGIBILITY_2027_NOT_CONFIRMED');
    notificationBlocked = true;
  }
  if (input.postalRequestStatus === 'EFFECTIVE_REQUEST') {
    const requestReceivedAt = input.postalRequestReceivedAt
      ? startOfUtcDay(input.postalRequestReceivedAt)
      : null;
    // Ein Antrag wirkt nur für die Zukunft. War er bei der konkreten
    // Bereitstellung bereits zugegangen, wird der tatsächliche Vorgang
    // samt möglicher Wiedereinsetzung fachlich geprüft. Ein erst später
    // zugegangener Antrag blockiert diesen früheren Vorgang nicht.
    if (!requestReceivedAt || !provisionDate || requestReceivedAt <= provisionDate) {
      reasons.push('POSTAL_REQUEST_EFFECT_REQUIRES_REVIEW');
      notificationBlocked = true;
      // Wurde trotz bereits wirksamem Postantrag elektronisch bereitgestellt,
      // bleibt die tatsächliche Bekanntgabeform fachlich zu würdigen.
      reinstatementReviewRequired = true;
    }
  } else if (input.postalRequestStatus !== 'NO_EFFECTIVE_REQUEST') {
    reasons.push('POSTAL_REQUEST_STATUS_UNKNOWN');
    notificationBlocked = true;
  }

  return {
    regime: 'DEFAULT_FROM_2027',
    reasons,
    notificationBlocked,
    reinstatementReviewRequired,
  };
}

function resolveModernDataRetrievalNotification(
  input: DataRetrievalDeadlineAssessmentInput,
  issuedYear: number,
  provisionDate: Date | null,
): DataRetrievalNotificationResolution {
  const requirements = assessModernDataRetrievalRequirements(input, issuedYear, provisionDate);
  const resolution: DataRetrievalNotificationResolution = {
    ...requirements,
    notificationDate: null,
    controlNotificationDate: null,
    notificationWorkdayAssessment: null,
    notificationDutyDeviation: false,
  };

  if (provisionDate) {
    resolution.notificationWorkdayAssessment = assessStandardWorkday(
      addCalendarDays(provisionDate, BEKANNTGABE_FIKTION_TAGE),
      input.notificationHolidayContext,
    );
    resolution.controlNotificationDate = resolution.notificationWorkdayAssessment.controlDate;
    if (resolution.notificationWorkdayAssessment.date) {
      resolution.notificationDate = resolution.notificationWorkdayAssessment.date;
    } else {
      resolution.reasons.push('NOTIFICATION_WORKDAY_REVIEW_REQUIRED');
      resolution.notificationBlocked = true;
    }
  }

  const notificationStatus = input.notificationStatus ?? 'UNKNOWN';
  if (notificationStatus === 'UNKNOWN') {
    resolution.reasons.push('NOTIFICATION_OUTCOME_UNKNOWN');
  } else if (notificationStatus !== 'SAME_DAY_CONFIRMED') {
    resolution.reasons.push('NOTIFICATION_DUTY_DEVIATION_REQUIRES_SECTION_110_REVIEW');
    resolution.reinstatementReviewRequired = true;
    resolution.notificationDutyDeviation = true;
  }

  return resolution;
}

function resolveDataRetrievalNotification(
  input: DataRetrievalDeadlineAssessmentInput,
  issuedAt: Date | null,
  provisionDate: Date | null,
): DataRetrievalNotificationResolution {
  if (issuedAt) {
    const issuedYear = issuedAt.getUTCFullYear();
    if (issuedYear <= 2025) {
      return resolveLegacyDataRetrievalNotification(input, provisionDate);
    }
    return resolveModernDataRetrievalNotification(input, issuedYear, provisionDate);
  }

  return {
    regime: 'UNKNOWN',
    reasons: [],
    notificationBlocked: false,
    notificationDate: null,
    controlNotificationDate: null,
    notificationWorkdayAssessment: null,
    reinstatementReviewRequired: false,
    notificationDutyDeviation: false,
  };
}

/**
 * Beweisorientierte §-122a-Berechnung mit Erlassdatum-Cutover, konservativer
 * 2026-Einwilligung und Postantragsprüfung ab 2027. Ein Fehler der
 * Benachrichtigung verändert den Fiktionstag nicht, erzeugt aber ausdrücklich
 * einen manuellen §-110-Prüffall.
 */
export function assessDataRetrievalDeadline(
  input: DataRetrievalDeadlineAssessmentInput,
): DataRetrievalDeadlineAssessmentResult {
  const issuedAt = input.issuedAt ? startOfUtcDay(input.issuedAt) : null;
  const provisionDate = input.provisionDate ? startOfUtcDay(input.provisionDate) : null;
  const prerequisites = assessDataRetrievalPrerequisites(input, issuedAt, provisionDate);
  const notification = resolveDataRetrievalNotification(input, issuedAt, provisionDate);
  const notificationBlocked = prerequisites.notificationBlocked || notification.notificationBlocked;
  const deadline = assessNotificationDeadline(
    notification.notificationDate,
    notification.controlNotificationDate,
    notificationBlocked,
    input.legalRemedyInstruction,
    input.deadlineHolidayContext,
  );
  const manualReviewReasons = unique([
    ...prerequisites.reasons,
    ...notification.reasons,
    ...deadline.reasons,
  ]);
  const status: DataRetrievalDeadlineAssessmentResult['status'] =
    notificationBlocked || deadline.deadlineBlocked
      ? 'MANUAL_REVIEW'
      : manualReviewReasons.length > 0
        ? 'CALCULATED_WITH_REVIEW'
        : 'CALCULATED';

  return {
    status,
    regime: notification.regime,
    notificationDate: notificationBlocked ? null : notification.notificationDate,
    deadline: notificationBlocked || deadline.deadlineBlocked ? null : deadline.deadline,
    controlNotificationDate: notification.controlNotificationDate,
    controlDeadline: deadline.controlDeadline,
    manualReviewReasons,
    reinstatementReviewRequired: notification.reinstatementReviewRequired,
    notificationDutyDeviation: notification.notificationDutyDeviation,
    notificationWorkdayAssessment: notification.notificationWorkdayAssessment,
    deadlineWorkdayAssessment: deadline.deadlineWorkdayAssessment,
  };
}
