import type { Prisma, TaxNoticeStatus } from '@prisma/client';
import { assessAppealDeadline, startOfUtcDay, type HolidayLocationContext } from '@taxtronik/tax';
import { NOTICE_STATUS_TRANSITIONS } from './transitions';

export interface LegacyNoticeEvidenceInput {
  appealFiledDate?: string;
  appealResolvedDate?: string;
  partialReliefReceivedDate?: string;
  appealDecisionReceivedDate?: string;
  klageFiledDate?: string;
}

export interface NoticeTransitionSource {
  status: TaxNoticeStatus;
  noticeDate: Date;
  appealDeadline: Date | null;
  deadlineCalculationStatus: string;
  manualReviewRequired: boolean;
  reviewedAt: Date | null;
  appealFiledAt: Date | null;
  appealFiledBy: string | null;
  partialReliefReceivedAt: Date | null;
  partialReliefReceivedBy: string | null;
  appealResolvedAt: Date | null;
  appealDecisionReceivedAt: Date | null;
  appealDecisionLegalRemedyInstructionValid: boolean | null;
  klageDeadline: Date | null;
  klageFiledAt: Date | null;
  klageFiledBy: string | null;
}

export interface NoticeTransitionRequest {
  status: TaxNoticeStatus;
  eventDateInput?: string;
  eventDate: Date | null;
  decisionLegalRemedyInstructionValid: boolean | null;
  legalFinalReason: string | null;
  legacyEvidence?: LegacyNoticeEvidenceInput;
  legacyAppealFiledAt: Date | null;
  legacyAppealResolvedAt: Date | null;
  legacyPartialReliefReceivedAt: Date | null;
  legacyDecisionReceivedAt: Date | null;
  legacyKlageFiledAt: Date | null;
}

export interface NoticeTransitionPlan {
  ok: true;
  data: Prisma.TaxNoticeUpdateManyMutationInput;
  auditAfter: Record<string, unknown>;
}

interface NoticeTransitionFailure {
  ok: false;
  error: string;
}

interface EvidenceRequirements {
  appealChain: boolean;
  abhilfe: boolean;
  partialRelief: boolean;
  decision: boolean;
  klage: boolean;
}

interface EffectiveEvidence {
  appealFiledAt: Date | null;
  appealFiledBy: string | null;
  partialReliefReceivedAt: Date | null;
  partialReliefReceivedBy: string | null;
  appealResolvedAt: Date | null;
  decisionReceivedAt: Date | null;
  decisionInstructionValid: boolean | null;
  klageFiledAt: Date | null;
  klageFiledBy: string | null;
}

interface PlannerArguments {
  before: NoticeTransitionSource;
  request: NoticeTransitionRequest;
  staffId: string;
  now: Date;
  deadlineHolidayContext: HolidayLocationContext;
}

interface TransitionContext extends PlannerArguments {
  evidence: EffectiveEvidence;
  klageFrist: Date | null;
  klageDeadlineReviewReasons: readonly string[];
}

type TransitionResult = NoticeTransitionPlan | NoticeTransitionFailure;
type UpdateBuilder = (context: TransitionContext) => Prisma.TaxNoticeUpdateManyMutationInput;

const NO_EVIDENCE: EvidenceRequirements = {
  appealChain: false,
  abhilfe: false,
  partialRelief: false,
  decision: false,
  klage: false,
};

const SOURCE_EVIDENCE_RULES: Record<TaxNoticeStatus, EvidenceRequirements> = {
  NEU: NO_EVIDENCE,
  GEPRUEFT: NO_EVIDENCE,
  EINSPRUCH: { ...NO_EVIDENCE, appealChain: true },
  ABGEHOLFEN: { ...NO_EVIDENCE, appealChain: true, abhilfe: true },
  // TAX-CONTROL-STATUS-001: Eine Teilabhilfe ist ein Änderungsbescheid im
  // laufenden Einspruchsverfahren, keine (Teil-)Einspruchsentscheidung.
  TEILABHILFE: { ...NO_EVIDENCE, appealChain: true, partialRelief: true },
  TEILEINSPRUCHSENTSCHEIDUNG: {
    ...NO_EVIDENCE,
    appealChain: true,
    decision: true,
  },
  ZURUECKGEWIESEN: { ...NO_EVIDENCE, appealChain: true, decision: true },
  KLAGE: {
    ...NO_EVIDENCE,
    appealChain: true,
    decision: true,
    klage: true,
  },
  BESTANDSKRAEFTIG: NO_EVIDENCE,
};

const DECISION_STATUSES = new Set<TaxNoticeStatus>([
  'TEILEINSPRUCHSENTSCHEIDUNG',
  'ZURUECKGEWIESEN',
]);

function invalid(error: string): NoticeTransitionFailure {
  return { ok: false, error };
}

function validateTransition(
  before: NoticeTransitionSource,
  status: TaxNoticeStatus,
): NoticeTransitionFailure | null {
  const allowed = NOTICE_STATUS_TRANSITIONS[before.status] ?? [];
  return allowed.includes(status)
    ? null
    : invalid(`Statuswechsel ${before.status} → ${status} ist nicht zulässig.`);
}

function validateLegacyScope(
  request: NoticeTransitionRequest,
  requirements: EvidenceRequirements,
): NoticeTransitionFailure | null {
  const scopedEvidence = [
    [request.legacyAppealFiledAt, requirements.appealChain],
    [request.legacyAppealResolvedAt, requirements.abhilfe],
    [request.legacyPartialReliefReceivedAt, requirements.partialRelief],
    [request.legacyDecisionReceivedAt, requirements.decision],
    [request.legacyKlageFiledAt, requirements.klage],
  ] as const;

  return scopedEvidence.some(([evidence, allowed]) => evidence && !allowed)
    ? invalid('Der übermittelte Altbestandsnachweis passt nicht zum aktuellen Verfahren.')
    : null;
}

function validateLegacyMatches(
  before: NoticeTransitionSource,
  request: NoticeTransitionRequest,
): NoticeTransitionFailure | null {
  const comparisons: ReadonlyArray<readonly [Date | null, Date | null, string]> = [
    [
      before.appealFiledAt ? startOfUtcDay(before.appealFiledAt) : null,
      request.legacyAppealFiledAt,
      'Der bestätigte Einspruchstag weicht vom Bestandsdatum ab.',
    ],
    [
      before.appealResolvedAt ? startOfUtcDay(before.appealResolvedAt) : null,
      request.legacyAppealResolvedAt,
      'Der bestätigte Erledigungs- oder Abhilfetag weicht vom Bestandsdatum ab.',
    ],
    [
      before.partialReliefReceivedAt,
      request.legacyPartialReliefReceivedAt,
      'Der bestätigte Bekanntgabetag der Teilabhilfe weicht vom Bestandsdatum ab.',
    ],
    [
      before.appealDecisionReceivedAt,
      request.legacyDecisionReceivedAt,
      'Der bestätigte Bekanntgabetag weicht vom Bestandsdatum ab.',
    ],
    [
      before.klageFiledAt ? startOfUtcDay(before.klageFiledAt) : null,
      request.legacyKlageFiledAt,
      'Der bestätigte Klageeinreichungstag weicht vom Bestandsdatum ab.',
    ],
  ];
  const mismatch = comparisons.find(
    ([current, legacy]) => current && legacy && current.getTime() !== legacy.getTime(),
  );

  return mismatch ? invalid(mismatch[2]) : null;
}

function filingTimeliness(
  filedAt: Date | null,
  deadline: Date | null,
): 'NOT_APPLICABLE' | 'DEADLINE_UNKNOWN' | 'TIMELY' | 'LATE_REVIEW_REQUIRED' {
  if (!filedAt) return 'NOT_APPLICABLE';
  if (!deadline) return 'DEADLINE_UNKNOWN';
  return startOfUtcDay(filedAt) <= startOfUtcDay(deadline) ? 'TIMELY' : 'LATE_REVIEW_REQUIRED';
}

function deriveAppealDecisionEvidence(
  before: NoticeTransitionSource,
  request: NoticeTransitionRequest,
  requirements: EvidenceRequirements,
  isDecisionStatus: boolean,
): Pick<EffectiveEvidence, 'decisionReceivedAt' | 'decisionInstructionValid' | 'appealResolvedAt'> {
  // Bei einer neuen Einspruchsentscheidung muss deren aktueller
  // Bekanntgabetag gewinnen. So werden auch Altdaten korrigiert, in denen eine
  // Teilabhilfe fälschlich als Entscheidung gespeichert worden war.
  const decisionReceivedAt = isDecisionStatus
    ? request.eventDate
    : (before.appealDecisionReceivedAt ?? request.legacyDecisionReceivedAt);
  const decisionInstructionValid = isDecisionStatus
    ? request.decisionLegalRemedyInstructionValid
    : (before.appealDecisionLegalRemedyInstructionValid ??
      request.decisionLegalRemedyInstructionValid);
  const appealResolvedAt =
    request.status === 'ABGEHOLFEN' || request.status === 'ZURUECKGEWIESEN'
      ? request.eventDate
      : (request.legacyAppealResolvedAt ??
        (request.legacyDecisionReceivedAt && requirements.decision
          ? request.legacyDecisionReceivedAt
          : (before.appealResolvedAt ?? decisionReceivedAt)));

  return { decisionReceivedAt, decisionInstructionValid, appealResolvedAt };
}

function deriveEffectiveEvidence({
  before,
  request,
  staffId,
}: PlannerArguments): EffectiveEvidence {
  const isDecisionStatus = DECISION_STATUSES.has(request.status);
  const requirements = SOURCE_EVIDENCE_RULES[before.status];
  const appealFiledAt =
    before.appealFiledAt ??
    (request.status === 'EINSPRUCH' ? request.eventDate : request.legacyAppealFiledAt);
  const decisionEvidence = deriveAppealDecisionEvidence(
    before,
    request,
    requirements,
    isDecisionStatus,
  );

  return {
    appealFiledAt,
    appealFiledBy:
      before.appealFiledBy ??
      (request.status === 'EINSPRUCH' || request.legacyAppealFiledAt ? staffId : null),
    partialReliefReceivedAt:
      request.status === 'TEILABHILFE'
        ? request.eventDate
        : (before.partialReliefReceivedAt ?? request.legacyPartialReliefReceivedAt),
    partialReliefReceivedBy:
      request.status === 'TEILABHILFE'
        ? staffId
        : before.partialReliefReceivedAt && before.partialReliefReceivedBy
          ? before.partialReliefReceivedBy
          : request.legacyPartialReliefReceivedAt
            ? staffId
            : before.partialReliefReceivedBy,
    ...decisionEvidence,
    klageFiledAt:
      before.klageFiledAt ??
      (request.status === 'KLAGE' ? request.eventDate : request.legacyKlageFiledAt),
    klageFiledBy:
      before.klageFiledBy ??
      (request.status === 'KLAGE' || request.legacyKlageFiledAt ? staffId : null),
  };
}

function validateRequiredEvidence(
  evidence: EffectiveEvidence,
  requirements: EvidenceRequirements,
  targetStatus: TaxNoticeStatus,
): NoticeTransitionFailure | null {
  const missingEvidence: ReadonlyArray<readonly [boolean, string]> = [
    [
      requirements.appealChain && (!evidence.appealFiledAt || !evidence.appealFiledBy),
      'Der Nachweis der tatsächlichen Einspruchseinlegung muss zuerst bestätigt werden.',
    ],
    [
      requirements.abhilfe && !evidence.appealResolvedAt,
      'Der tatsächliche Bekanntgabetag der Abhilfe muss zuerst bestätigt werden.',
    ],
    [
      (requirements.partialRelief || targetStatus === 'TEILABHILFE') &&
        (!evidence.partialReliefReceivedAt || !evidence.partialReliefReceivedBy),
      'Bekanntgabetag und dokumentierende Person der Teilabhilfe müssen zuerst bestätigt werden.',
    ],
    [
      requirements.decision &&
        (!evidence.decisionReceivedAt || evidence.decisionInstructionValid === null),
      'Bekanntgabetag und Rechtsbehelfsbelehrung der Einspruchsentscheidung müssen zuerst bestätigt werden.',
    ],
    [
      requirements.klage && (!evidence.klageFiledAt || !evidence.klageFiledBy),
      'Der Nachweis der tatsächlichen Klageeinreichung muss zuerst bestätigt werden.',
    ],
  ];
  const missing = missingEvidence.find(([condition]) => condition);

  return missing ? invalid(missing[1]) : null;
}

function validatePartialReliefEventOrder(
  evidence: EffectiveEvidence,
): NoticeTransitionFailure | null {
  const partialReliefAt = evidence.partialReliefReceivedAt;
  if (!partialReliefAt) return null;
  if (!evidence.appealFiledAt || partialReliefAt < startOfUtcDay(evidence.appealFiledAt)) {
    return invalid(
      'Die Bekanntgabe der Teilabhilfe darf nicht vor der Einspruchseinlegung liegen.',
    );
  }

  const followUpEvents: ReadonlyArray<readonly [Date | null, string]> = [
    [
      evidence.decisionReceivedAt,
      'Die Bekanntgabe der Einspruchsentscheidung darf nicht vor der Teilabhilfe liegen.',
    ],
    [
      evidence.appealResolvedAt ? startOfUtcDay(evidence.appealResolvedAt) : null,
      'Die vollständige Abhilfe darf nicht vor der Teilabhilfe liegen.',
    ],
    [
      evidence.klageFiledAt ? startOfUtcDay(evidence.klageFiledAt) : null,
      'Die Klageeinreichung darf nicht vor der Teilabhilfe liegen.',
    ],
  ];
  const violation = followUpEvents.find(([eventAt]) => eventAt && eventAt < partialReliefAt);
  return violation ? invalid(violation[1]) : null;
}

function validateProcedureEventOrder(
  before: NoticeTransitionSource,
  evidence: EffectiveEvidence,
): NoticeTransitionFailure | null {
  if (evidence.appealFiledAt && startOfUtcDay(evidence.appealFiledAt) < before.noticeDate) {
    return invalid('Die Einspruchseinlegung darf nicht vor dem Bescheiddatum liegen.');
  }
  const partialReliefFailure = validatePartialReliefEventOrder(evidence);
  if (partialReliefFailure) return partialReliefFailure;
  if (
    evidence.appealResolvedAt &&
    evidence.appealFiledAt &&
    startOfUtcDay(evidence.appealResolvedAt) < startOfUtcDay(evidence.appealFiledAt)
  ) {
    return invalid(
      'Die Bekanntgabe der Einspruchsentscheidung darf nicht vor der Einspruchseinlegung liegen.',
    );
  }
  if (
    evidence.decisionReceivedAt &&
    evidence.appealFiledAt &&
    evidence.decisionReceivedAt < startOfUtcDay(evidence.appealFiledAt)
  ) {
    return invalid(
      'Die Bekanntgabe der Einspruchsentscheidung darf nicht vor der Einspruchseinlegung liegen.',
    );
  }
  if (evidence.klageFiledAt && !evidence.decisionReceivedAt) {
    return invalid('Der tatsächliche Bekanntgabetag der Einspruchsentscheidung fehlt.');
  }
  if (
    evidence.klageFiledAt &&
    evidence.decisionReceivedAt &&
    startOfUtcDay(evidence.klageFiledAt) < evidence.decisionReceivedAt
  ) {
    return invalid(
      'Die Klageeinreichung darf nicht vor der Bekanntgabe der Einspruchsentscheidung liegen.',
    );
  }
  return null;
}

function validateLegalFinalOrder(
  before: NoticeTransitionSource,
  request: NoticeTransitionRequest,
  evidence: EffectiveEvidence,
): NoticeTransitionFailure | null {
  if (request.status !== 'BESTANDSKRAEFTIG' || !request.eventDate) return null;
  const priorEvents = [
    before.noticeDate,
    evidence.appealFiledAt ? startOfUtcDay(evidence.appealFiledAt) : null,
    evidence.partialReliefReceivedAt,
    evidence.appealResolvedAt ? startOfUtcDay(evidence.appealResolvedAt) : null,
    evidence.decisionReceivedAt,
    evidence.klageFiledAt ? startOfUtcDay(evidence.klageFiledAt) : null,
  ].filter((date): date is Date => date !== null);
  const latestPriorEvent = priorEvents.reduce(
    (latest, date) => (date > latest ? date : latest),
    before.noticeDate,
  );

  if (request.eventDate < latestPriorEvent) {
    return invalid(
      'Der Eintritt der Bestandskraft darf nicht vor einem dokumentierten Verfahrensereignis liegen.',
    );
  }
  if (!request.legalFinalReason || request.legalFinalReason.trim().length < 10) {
    return invalid(
      'Die fachliche Abschlussentscheidung zur Bestandskraft muss nachvollziehbar begründet werden.',
    );
  }
  if (before.status === 'GEPRUEFT') {
    if (
      before.deadlineCalculationStatus !== 'CALCULATED' ||
      before.manualReviewRequired ||
      !before.appealDeadline
    ) {
      return invalid(
        'Bestandskraft darf erst nach einer vollständig berechneten und fachlich geprüften Einspruchsfrist festgestellt werden.',
      );
    }
    if (request.eventDate <= before.appealDeadline) {
      return invalid(
        'Bestandskraft darf erst nach Ablauf der Einspruchsfrist festgestellt werden.',
      );
    }
    if (before.appealFiledAt) {
      return invalid(
        'Bei dokumentiertem Einspruch darf der Bescheid nicht aus „Geprüft“ abgeschlossen werden.',
      );
    }
  }
  if (before.status === 'ZURUECKGEWIESEN') {
    if (!before.klageDeadline || request.eventDate <= before.klageDeadline) {
      return invalid(
        'Bestandskraft darf erst nach Ablauf der dokumentierten Klagefrist festgestellt werden.',
      );
    }
  }
  return null;
}

function assessKlageDeadline(
  before: NoticeTransitionSource,
  evidence: EffectiveEvidence,
  deadlineHolidayContext: HolidayLocationContext,
  targetStatus: TaxNoticeStatus,
): { deadline: Date | null; manualReviewReasons: readonly string[] } {
  // TAX-CONTROL-STATUS-001: TEILABHILFE allein löst keine Klagefrist aus.
  // Beim Abschluss durch vollständige Abhilfe werden zudem fehlerhafte
  // Altbestandswerte aus der früheren Zuordnung nicht fortgeführt.
  if (
    targetStatus === 'TEILABHILFE' ||
    (before.status === 'TEILABHILFE' && targetStatus === 'ABGEHOLFEN')
  ) {
    return { deadline: null, manualReviewReasons: [] };
  }
  if (!DECISION_STATUSES.has(targetStatus) && before.klageDeadline) {
    return { deadline: before.klageDeadline, manualReviewReasons: [] };
  }
  if (!evidence.decisionReceivedAt || evidence.decisionInstructionValid === null) {
    return { deadline: null, manualReviewReasons: [] };
  }

  // Die Klagefrist beginnt am bereits festgestellten Bekanntgabetag der
  // Einspruchsentscheidung; eine Bekanntgabefiktion wird nicht erneut addiert.
  // Die gemeinsame Assessment-API sorgt zugleich dafür, dass ein unvollständig
  // geprüfter Feiertagsort niemals als abschließendes Rechtsdatum erscheint.
  const assessment = assessAppealDeadline({
    deliveryMethod: 'DETERMINED_NOTIFICATION',
    determinedNotificationDate: evidence.decisionReceivedAt,
    legalRemedyInstruction: evidence.decisionInstructionValid ? 'VALID' : 'INVALID_OR_MISSING',
    notificationHolidayContext: deadlineHolidayContext,
    deadlineHolidayContext,
  });
  return {
    deadline: assessment.deadline,
    manualReviewReasons: assessment.manualReviewReasons,
  };
}

function buildDecisionUpdate(context: TransitionContext): Prisma.TaxNoticeUpdateManyMutationInput {
  return {
    status: context.request.status,
    // Die Teil-Einspruchsentscheidung erledigt nur den ausdrücklich
    // entschiedenen Teil. Das übrige Einspruchsverfahren bleibt offen.
    appealResolvedAt:
      context.request.status === 'ZURUECKGEWIESEN' ? context.request.eventDate : null,
    appealDecisionReceivedAt: context.request.eventDate,
    appealDecisionLegalRemedyInstructionValid: context.request.decisionLegalRemedyInstructionValid,
    klageDeadline: context.klageFrist,
  };
}

function buildPartialReliefUpdate({
  evidence,
}: TransitionContext): Prisma.TaxNoticeUpdateManyMutationInput {
  return {
    status: 'TEILABHILFE',
    // TAX-CONTROL-STATUS-001, TAX-NOTICE-APPEAL-001: Die verlangte
    // Tatsacheneingabe wird im Fachobjekt gespeichert. Das Audit erhält
    // weiterhin nur den datensparsamen Boolean-Nachweis.
    partialReliefReceivedAt: evidence.partialReliefReceivedAt,
    partialReliefReceivedBy: evidence.partialReliefReceivedBy,
    // Eine Teilabhilfe erledigt den Einspruch nicht und liefert keinen
    // Klagefristbeginn. Die Nullsetzung verhindert, dass alte Fehlzuordnungen
    // in der operativen Sicht fortleben.
    appealResolvedAt: null,
    appealDecisionReceivedAt: null,
    appealDecisionLegalRemedyInstructionValid: null,
    klageDeadline: null,
  };
}

const STATUS_UPDATE_BUILDERS: Record<TaxNoticeStatus, UpdateBuilder> = {
  NEU: () => ({ status: 'NEU', reviewedAt: null, reviewedBy: null }),
  GEPRUEFT: ({ now, staffId }) => ({
    status: 'GEPRUEFT',
    reviewedAt: now,
    reviewedBy: staffId,
  }),
  EINSPRUCH: ({ before, evidence, now, staffId }) => ({
    status: 'EINSPRUCH',
    appealFiledAt: evidence.appealFiledAt,
    appealFiledBy: evidence.appealFiledBy,
    ...(before.reviewedAt ? {} : { reviewedAt: now, reviewedBy: staffId }),
  }),
  ABGEHOLFEN: ({ before, request }) => ({
    status: 'ABGEHOLFEN',
    appealResolvedAt: request.eventDate,
    ...(before.status === 'TEILABHILFE'
      ? {
          appealDecisionReceivedAt: null,
          appealDecisionLegalRemedyInstructionValid: null,
          klageDeadline: null,
        }
      : {}),
  }),
  TEILABHILFE: buildPartialReliefUpdate,
  TEILEINSPRUCHSENTSCHEIDUNG: buildDecisionUpdate,
  ZURUECKGEWIESEN: buildDecisionUpdate,
  KLAGE: ({ request, staffId }) => ({
    status: 'KLAGE',
    klageFiledAt: request.eventDate,
    klageFiledBy: staffId,
  }),
  BESTANDSKRAEFTIG: ({ request, staffId }) => ({
    status: 'BESTANDSKRAEFTIG',
    legalFinalAt: request.eventDate,
    legalFinalBy: staffId,
    legalFinalReason: request.legalFinalReason,
  }),
};

function buildLegacyEvidenceUpdate({
  request,
  evidence,
  klageFrist,
}: TransitionContext): Prisma.TaxNoticeUpdateManyMutationInput {
  const data: Prisma.TaxNoticeUpdateManyMutationInput = {};
  if (request.legacyAppealFiledAt) {
    data.appealFiledAt = evidence.appealFiledAt;
    data.appealFiledBy = evidence.appealFiledBy;
  }
  if (request.legacyAppealResolvedAt || request.legacyDecisionReceivedAt) {
    data.appealResolvedAt = evidence.appealResolvedAt;
  }
  if (request.legacyPartialReliefReceivedAt) {
    data.partialReliefReceivedAt = evidence.partialReliefReceivedAt;
    data.partialReliefReceivedBy = evidence.partialReliefReceivedBy;
  }
  if (request.legacyDecisionReceivedAt) {
    data.appealDecisionReceivedAt = evidence.decisionReceivedAt;
    data.appealDecisionLegalRemedyInstructionValid = evidence.decisionInstructionValid;
    data.klageDeadline = klageFrist;
  }
  if (request.legacyKlageFiledAt) {
    data.klageFiledAt = evidence.klageFiledAt;
    data.klageFiledBy = evidence.klageFiledBy;
  }
  return data;
}

/**
 * Pure, table-driven transition planner. It owns the complete evidence and
 * event-order contract; the server action is limited to loading, access
 * control, compare-and-swap persistence and audit recording.
 */
export function planNoticeTransition(arguments_: PlannerArguments): TransitionResult {
  const { before, request, deadlineHolidayContext } = arguments_;
  const transitionFailure = validateTransition(before, request.status);
  if (transitionFailure) return transitionFailure;

  const requirements = SOURCE_EVIDENCE_RULES[before.status];
  const legacyFailure =
    validateLegacyScope(request, requirements) ?? validateLegacyMatches(before, request);
  if (legacyFailure) return legacyFailure;

  const evidence = deriveEffectiveEvidence(arguments_);
  const evidenceFailure =
    validateRequiredEvidence(evidence, requirements, request.status) ??
    validateProcedureEventOrder(before, evidence) ??
    validateLegalFinalOrder(before, request, evidence);
  if (evidenceFailure) return evidenceFailure;

  const klageAssessment = assessKlageDeadline(
    before,
    evidence,
    deadlineHolidayContext,
    request.status,
  );
  const requiresCalculatedKlageDeadline =
    DECISION_STATUSES.has(request.status) || request.status === 'KLAGE';
  if (requiresCalculatedKlageDeadline && !klageAssessment.deadline) {
    return invalid(
      'Die Klagefrist kann ohne vollständig geprüften Feiertagskontext des Behördensitzes nicht festgelegt werden.',
    );
  }
  const klageFrist = klageAssessment.deadline;
  const context = {
    ...arguments_,
    evidence,
    klageFrist,
    klageDeadlineReviewReasons: klageAssessment.manualReviewReasons,
  };

  return {
    ok: true,
    data: {
      ...STATUS_UPDATE_BUILDERS[request.status](context),
      ...buildLegacyEvidenceUpdate(context),
    },
    auditAfter: {
      status: request.status,
      eventDateRecorded: request.eventDate !== null,
      partialReliefReceiptRecorded: Boolean(
        evidence.partialReliefReceivedAt && evidence.partialReliefReceivedBy,
      ),
      klageDeadlineCalculated: klageFrist !== null,
      klageDeadlineReviewReasons: klageAssessment.manualReviewReasons,
      decisionLegalRemedyInstructionValid: request.decisionLegalRemedyInstructionValid,
      legalFinalReasonRecorded: Boolean(request.legalFinalReason?.trim()),
      legacyEvidenceFieldsConfirmed: Object.entries(request.legacyEvidence ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field),
      appealFilingTimeliness: filingTimeliness(evidence.appealFiledAt, before.appealDeadline),
      klageFilingTimeliness: filingTimeliness(evidence.klageFiledAt, klageFrist),
    },
  };
}
