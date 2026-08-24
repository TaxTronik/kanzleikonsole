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

/**
 * Prüft Anwendbarkeit und Feiertagskontext vor der kalendarischen Verschiebung.
 * Anders als shiftToNextWorkday gibt diese API bei unvollständigem Kontext kein
 * scheinbar abschließendes Rechtsdatum zurück.
 */
export function assessWorkdayShift(input: WorkdayShiftAssessmentInput): WorkdayShiftAssessment {
  const original = startOfUtcDay(input.date);
  const reasons: WorkdayManualReviewReason[] = [];

  switch (input.applicationType) {
    case 'AUTHORITY_PERFORMANCE_PERIOD':
      reasons.push('AUTHORITY_PERFORMANCE_PERIOD_REQUIRES_SEPARATE_REVIEW');
      break;
    case 'AUTHORITY_FIXED_DATE':
      reasons.push('AUTHORITY_FIXED_DATE_REQUIRES_SEPARATE_REVIEW');
      break;
    case 'HOURLY_DEADLINE':
      reasons.push('HOURLY_DEADLINE_REQUIRES_SEPARATE_REVIEW');
      break;
    case 'UNCLEAR':
      reasons.push('APPLICATION_TYPE_UNCLEAR');
      break;
    case 'STANDARD_DEADLINE_END':
      break;
  }

  // § 108 Abs. 4 bis 6 AO wird nicht durch einen unverbindlichen Shift
  // vorweggenommen. Der Kontrollwert bleibt in diesen Fällen das Eingabedatum.
  if (input.applicationType !== 'STANDARD_DEADLINE_END') {
    return {
      status: 'MANUAL_REVIEW',
      date: null,
      controlDate: original,
      shifted: false,
      applicationType: input.applicationType,
      manualReviewReasons: reasons,
    };
  }

  const context = input.holidayContext;
  if (!context.countryCode) reasons.push('HOLIDAY_LOCATION_UNKNOWN');
  else if (context.countryCode !== 'DE') reasons.push('FOREIGN_HOLIDAY_CALENDAR_UNSUPPORTED');
  if (context.countryCode === 'DE' && !context.region) reasons.push('HOLIDAY_REGION_UNKNOWN');
  if (context.countryCode === 'DE' && (context.locality?.trim().length ?? 0) < 2) {
    reasons.push('HOLIDAY_LOCALITY_UNKNOWN');
  }

  switch (context.calendarStatus) {
    case 'CONFIRMED_FOR_DATE_AND_LOCATION':
      break;
    case 'STATE_LEVEL_ONLY':
      reasons.push('LOCAL_HOLIDAY_CALENDAR_INCOMPLETE');
      break;
    case 'HISTORICAL_UNVERIFIED':
      reasons.push('HISTORICAL_HOLIDAY_CALENDAR_UNVERIFIED');
      break;
    case 'FOREIGN_UNSUPPORTED':
      reasons.push('FOREIGN_HOLIDAY_CALENDAR_UNSUPPORTED');
      break;
    case 'UNKNOWN':
      reasons.push('HOLIDAY_CALENDAR_UNKNOWN');
      break;
  }

  if (
    context.countryCode === 'DE' &&
    context.region === 'DE-BY' &&
    context.bavariaAssumptionApplies == null
  ) {
    reasons.push('BAVARIA_ASSUMPTION_UNRESOLVED');
  }

  const controlDate = workdayCandidate(original, context);
  const manualReviewReasons = unique(reasons);
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

/**
 * Beweisorientierte Einspruchsfristberechnung. Unbekannte Versanddaten werden
 * nicht aus dem Bescheiddatum ersetzt; ein solcher Wert kann nur explizit als
 * riskReferenceDate in die getrennte Risikorechnung eingehen.
 */
export function assessAppealDeadline(
  input: AppealDeadlineAssessmentInput,
): AppealDeadlineAssessmentResult {
  const reasons: AppealManualReviewReason[] = [];
  let notificationBlocked = false;
  let deadlineBlocked = false;
  let riskOnly = false;
  let notificationDate: Date | null = null;
  let controlNotificationDate: Date | null = null;
  let riskNotificationDate: Date | null = null;
  let notificationWorkdayAssessment: WorkdayShiftAssessment | null = null;

  const access = input.access ?? { kind: 'NO_DEVIATION_REPORTED' as const };

  if (input.deliveryMethod === 'DETERMINED_NOTIFICATION') {
    if (input.determinedNotificationDate) {
      notificationDate = startOfUtcDay(input.determinedNotificationDate);
      controlNotificationDate = notificationDate;
    } else {
      reasons.push('DETERMINED_NOTIFICATION_DATE_MISSING');
      notificationBlocked = true;
    }
  } else if (input.dispatchDate) {
    notificationWorkdayAssessment = assessFictionDate(
      input.dispatchDate,
      input.deliveryMethod,
      input.notificationHolidayContext,
    );
    controlNotificationDate = notificationWorkdayAssessment.controlDate;
    if (notificationWorkdayAssessment.date) {
      notificationDate = notificationWorkdayAssessment.date;
    } else {
      reasons.push('NOTIFICATION_WORKDAY_REVIEW_REQUIRED');
      notificationBlocked = true;
    }
  } else if (access.kind === 'ACTUAL_ACCESS_DETERMINED') {
    // Ein unabhängig festgestellter tatsächlicher Zugang ist bei unbekanntem
    // Versandtag der einzige automatisch verwertbare Ausgangstag.
    notificationDate = startOfUtcDay(access.date);
    controlNotificationDate = notificationDate;
  } else {
    reasons.push('DISPATCH_DATE_UNKNOWN');
    notificationBlocked = true;
    if (input.riskReferenceDate) {
      notificationWorkdayAssessment = assessFictionDate(
        input.riskReferenceDate,
        input.deliveryMethod,
        input.notificationHolidayContext,
      );
      riskNotificationDate = notificationWorkdayAssessment.controlDate;
      controlNotificationDate = riskNotificationDate;
      reasons.push('RISK_DATE_ONLY');
      riskOnly = true;
    }
  }

  switch (access.kind) {
    case 'NO_DEVIATION_REPORTED':
      break;
    case 'NON_RECEIPT_DISPUTED':
      reasons.push('NON_RECEIPT_REQUIRES_EVIDENCE_REVIEW');
      notificationDate = null;
      notificationBlocked = true;
      break;
    case 'EARLIER_ACCESS_RECORDED': {
      const actual = startOfUtcDay(access.date);
      // Ein früher tatsächlicher Eingang verkürzt die Bekanntgabefiktion nicht.
      // Ist der als „früher“ erfasste Tag tatsächlich später, wird die
      // widersprüchliche Einordnung nicht stillschweigend verwertet.
      if (notificationDate && actual.getTime() > notificationDate.getTime()) {
        reasons.push('RECORDED_EARLIER_ACCESS_AFTER_FICTION');
        notificationDate = null;
        notificationBlocked = true;
      }
      break;
    }
    case 'LATER_ACCESS_CLAIMED': {
      const claimed = startOfUtcDay(access.date);
      reasons.push(
        controlNotificationDate && claimed.getTime() <= controlNotificationDate.getTime()
          ? 'CLAIMED_LATER_ACCESS_NOT_AFTER_FICTION'
          : 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW',
      );
      notificationDate = null;
      notificationBlocked = true;
      break;
    }
    case 'ACTUAL_ACCESS_DETERMINED': {
      const actual = startOfUtcDay(access.date);
      if (!notificationDate || actual.getTime() > notificationDate.getTime()) {
        notificationDate = actual;
      }
      // Ein früher Zugang verkürzt die Fiktion nicht. Der Kontrolltag folgt
      // deshalb ebenfalls nur einem tatsächlich späteren Zugang.
      if (!controlNotificationDate || actual.getTime() > controlNotificationDate.getTime()) {
        controlNotificationDate = actual;
      }
      break;
    }
  }

  if (input.legalRemedyInstruction === 'UNCLEAR') {
    reasons.push('LEGAL_REMEDY_INSTRUCTION_UNCLEAR');
    deadlineBlocked = true;
  }

  let deadline: Date | null = null;
  let controlDeadline: Date | null = null;
  let claimedAccessControlDeadline: Date | null = null;
  let riskDeadline: Date | null = null;
  let deadlineWorkdayAssessment: WorkdayShiftAssessment | null = null;

  if (controlNotificationDate) {
    deadlineWorkdayAssessment = assessPeriodEnd(
      controlNotificationDate,
      input.legalRemedyInstruction,
      input.deadlineHolidayContext,
    );
    controlDeadline = deadlineWorkdayAssessment.controlDate;
    if (!deadlineWorkdayAssessment.date) {
      reasons.push('DEADLINE_WORKDAY_REVIEW_REQUIRED');
      deadlineBlocked = true;
    }
  }

  if (riskNotificationDate && controlDeadline) riskDeadline = controlDeadline;

  if (
    access.kind === 'LATER_ACCESS_CLAIMED' &&
    (!controlNotificationDate ||
      startOfUtcDay(access.date).getTime() > controlNotificationDate.getTime())
  ) {
    // Beide Szenarien bleiben sichtbar: controlDeadline bildet die gesetzliche
    // Fiktion ab, dieser Wert ausschließlich die behauptete spätere Variante.
    // Keiner von beiden wird ohne fachliche Würdigung als Rechtsfrist freigegeben.
    claimedAccessControlDeadline = assessPeriodEnd(
      access.date,
      input.legalRemedyInstruction,
      input.deadlineHolidayContext,
    ).controlDate;
  }

  if (notificationDate && !notificationBlocked && !deadlineBlocked) {
    // Bei einem festgestellten späteren Zugang kann der zuvor berechnete
    // Kontrollwert abweichen; deshalb Fristende aus dem Rechtsdatum neu bilden.
    deadlineWorkdayAssessment = assessPeriodEnd(
      notificationDate,
      input.legalRemedyInstruction,
      input.deadlineHolidayContext,
    );
    controlDeadline = deadlineWorkdayAssessment.controlDate;
    if (deadlineWorkdayAssessment.date) deadline = deadlineWorkdayAssessment.date;
    else {
      reasons.push('DEADLINE_WORKDAY_REVIEW_REQUIRED');
      deadlineBlocked = true;
    }
  }

  const manualReviewReasons = unique(reasons);
  return {
    status: riskOnly
      ? 'RISK_ONLY'
      : manualReviewReasons.length > 0
        ? 'MANUAL_REVIEW'
        : 'CALCULATED',
    notificationDate: notificationBlocked ? null : notificationDate,
    deadline: notificationBlocked || deadlineBlocked ? null : deadline,
    controlNotificationDate,
    controlDeadline,
    claimedAccessControlDeadline,
    riskDeadline,
    manualReviewReasons,
    notificationWorkdayAssessment,
    deadlineWorkdayAssessment,
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

/**
 * Beweisorientierte §-122a-Berechnung mit Erlassdatum-Cutover, konservativer
 * 2026-Einwilligung und Postantragsprüfung ab 2027. Ein Fehler der
 * Benachrichtigung verändert den Fiktionstag nicht, erzeugt aber ausdrücklich
 * einen manuellen §-110-Prüffall.
 */
export function assessDataRetrievalDeadline(
  input: DataRetrievalDeadlineAssessmentInput,
): DataRetrievalDeadlineAssessmentResult {
  const reasons: DataRetrievalManualReviewReason[] = [];
  let notificationBlocked = false;
  let deadlineBlocked = false;
  let regime: DataRetrievalDeadlineAssessmentResult['regime'] = 'UNKNOWN';
  let notificationDate: Date | null = null;
  let controlNotificationDate: Date | null = null;
  let notificationWorkdayAssessment: WorkdayShiftAssessment | null = null;
  let reinstatementReviewRequired = false;
  let notificationDutyDeviation = false;

  const issuedAt = input.issuedAt ? startOfUtcDay(input.issuedAt) : null;
  const provisionDate = input.provisionDate ? startOfUtcDay(input.provisionDate) : null;

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

  if (issuedAt) {
    const year = issuedAt.getUTCFullYear();
    if (year <= 2025) {
      regime = 'LEGACY_UNTIL_2025';
      if (input.legacyNotificationDisputedOrLate) {
        if (input.legacyRetrievedAt) {
          notificationDate = startOfUtcDay(input.legacyRetrievedAt);
          controlNotificationDate = notificationDate;
        } else {
          reasons.push('LEGACY_NOTIFICATION_ACCESS_DISPUTED');
          notificationBlocked = true;
        }
      } else if (
        !input.notificationStatus ||
        ['FAILED', 'NOT_RECEIVED', 'UNKNOWN'].includes(input.notificationStatus)
      ) {
        // Im Altrecht ist die Benachrichtigung selbst der Ausgangsvorgang.
        // Ein bloß eingetragenes Datum darf einen fehlgeschlagenen oder
        // unklaren Versand nicht in einen nachgewiesenen Versand umdeuten.
        reasons.push('LEGACY_NOTIFICATION_OUTCOME_NOT_CONFIRMED');
        notificationBlocked = true;
      } else if (!input.legacyNotificationDate) {
        reasons.push('LEGACY_NOTIFICATION_DATE_UNKNOWN');
        notificationBlocked = true;
      } else if (provisionDate) {
        const notificationSent = startOfUtcDay(input.legacyNotificationDate);
        notificationWorkdayAssessment = assessStandardWorkday(
          // Art. 97 § 1 Abs. 15 EGAO knüpft den Wechsel von drei auf vier
          // Tage bei § 122a Abs. 4 AO an die elektronische Bereitstellung,
          // nicht an den gegebenenfalls späteren Benachrichtigungsversand.
          addCalendarDays(notificationSent, bekanntgabeFiktionTage(provisionDate)),
          input.notificationHolidayContext,
        );
        controlNotificationDate = notificationWorkdayAssessment.controlDate;
        if (notificationWorkdayAssessment.date) {
          notificationDate = notificationWorkdayAssessment.date;
        } else {
          reasons.push('NOTIFICATION_WORKDAY_REVIEW_REQUIRED');
          notificationBlocked = true;
        }
      }
    } else {
      if (year === 2026) {
        regime = 'CONSENT_2026';
        if (input.consent2026 !== 'ACTIVE_DOCUMENTED') {
          reasons.push('ACTIVE_CONSENT_2026_NOT_DOCUMENTED');
          notificationBlocked = true;
        }
      } else {
        regime = 'DEFAULT_FROM_2027';
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
            // Wurde trotz bereits wirksamem Postantrag elektronisch
            // bereitgestellt, bleibt die tatsächliche Bekanntgabeform
            // fachlich zu würdigen. Der getrennte Hinweis verhindert, dass
            // eine mögliche Wiedereinsetzung im manuellen Fall übersehen wird.
            reinstatementReviewRequired = true;
          }
        } else if (input.postalRequestStatus !== 'NO_EFFECTIVE_REQUEST') {
          reasons.push('POSTAL_REQUEST_STATUS_UNKNOWN');
          notificationBlocked = true;
        }
      }

      if (provisionDate) {
        notificationWorkdayAssessment = assessStandardWorkday(
          addCalendarDays(provisionDate, BEKANNTGABE_FIKTION_TAGE),
          input.notificationHolidayContext,
        );
        controlNotificationDate = notificationWorkdayAssessment.controlDate;
        if (notificationWorkdayAssessment.date) {
          notificationDate = notificationWorkdayAssessment.date;
        } else {
          reasons.push('NOTIFICATION_WORKDAY_REVIEW_REQUIRED');
          notificationBlocked = true;
        }
      }

      const notificationStatus = input.notificationStatus ?? 'UNKNOWN';
      if (notificationStatus === 'UNKNOWN') {
        reasons.push('NOTIFICATION_OUTCOME_UNKNOWN');
      } else if (notificationStatus !== 'SAME_DAY_CONFIRMED') {
        reasons.push('NOTIFICATION_DUTY_DEVIATION_REQUIRES_SECTION_110_REVIEW');
        reinstatementReviewRequired = true;
        notificationDutyDeviation = true;
      }
    }
  }

  if (input.legalRemedyInstruction === 'UNCLEAR') {
    reasons.push('LEGAL_REMEDY_INSTRUCTION_UNCLEAR');
    deadlineBlocked = true;
  }

  let deadline: Date | null = null;
  let controlDeadline: Date | null = null;
  let deadlineWorkdayAssessment: WorkdayShiftAssessment | null = null;
  if (controlNotificationDate) {
    deadlineWorkdayAssessment = assessPeriodEnd(
      controlNotificationDate,
      input.legalRemedyInstruction,
      input.deadlineHolidayContext,
    );
    controlDeadline = deadlineWorkdayAssessment.controlDate;
    if (!deadlineWorkdayAssessment.date) {
      reasons.push('DEADLINE_WORKDAY_REVIEW_REQUIRED');
      deadlineBlocked = true;
    }
  }

  if (notificationDate && !notificationBlocked && !deadlineBlocked) {
    deadlineWorkdayAssessment = assessPeriodEnd(
      notificationDate,
      input.legalRemedyInstruction,
      input.deadlineHolidayContext,
    );
    controlDeadline = deadlineWorkdayAssessment.controlDate;
    if (deadlineWorkdayAssessment.date) deadline = deadlineWorkdayAssessment.date;
    else {
      reasons.push('DEADLINE_WORKDAY_REVIEW_REQUIRED');
      deadlineBlocked = true;
    }
  }

  const manualReviewReasons = unique(reasons);
  const status: DataRetrievalDeadlineAssessmentResult['status'] =
    notificationBlocked || deadlineBlocked
      ? 'MANUAL_REVIEW'
      : manualReviewReasons.length > 0
        ? 'CALCULATED_WITH_REVIEW'
        : 'CALCULATED';

  return {
    status,
    regime,
    notificationDate: notificationBlocked ? null : notificationDate,
    deadline: notificationBlocked || deadlineBlocked ? null : deadline,
    controlNotificationDate,
    controlDeadline,
    manualReviewReasons,
    reinstatementReviewRequired,
    notificationDutyDeviation,
    notificationWorkdayAssessment,
    deadlineWorkdayAssessment,
  };
}
