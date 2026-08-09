import type { Prisma, TaxNoticeStatus } from '@prisma/client';
import { klageDeadline, startOfUtcDay, type GermanRegion } from '@taxtronik/tax';
import { NOTICE_STATUS_TRANSITIONS } from './transitions';

export interface LegacyNoticeEvidenceInput {
  appealFiledDate?: string;
  appealResolvedDate?: string;
  appealDecisionReceivedDate?: string;
  klageFiledDate?: string;
}

export interface NoticeTransitionSource {
  status: TaxNoticeStatus;
  noticeDate: Date;
  reviewedAt: Date | null;
  appealFiledAt: Date | null;
  appealFiledBy: string | null;
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
  legacyEvidence?: LegacyNoticeEvidenceInput;
  legacyAppealFiledAt: Date | null;
  legacyAppealResolvedAt: Date | null;
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
  decision: boolean;
  klage: boolean;
}

interface EffectiveEvidence {
  appealFiledAt: Date | null;
  appealFiledBy: string | null;
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
  region: GermanRegion | null;
}

interface TransitionContext extends PlannerArguments {
  evidence: EffectiveEvidence;
  klageFrist: Date | null;
}

type TransitionResult = NoticeTransitionPlan | NoticeTransitionFailure;
type UpdateBuilder = (context: TransitionContext) => Prisma.TaxNoticeUpdateManyMutationInput;

const NO_EVIDENCE: EvidenceRequirements = {
  appealChain: false,
  abhilfe: false,
  decision: false,
  klage: false,
};

const SOURCE_EVIDENCE_RULES: Record<TaxNoticeStatus, EvidenceRequirements> = {
  NEU: NO_EVIDENCE,
  GEPRUEFT: NO_EVIDENCE,
  EINSPRUCH: { ...NO_EVIDENCE, appealChain: true },
  ABGEHOLFEN: { ...NO_EVIDENCE, appealChain: true, abhilfe: true },
  TEILABHILFE: { ...NO_EVIDENCE, appealChain: true, decision: true },
  ZURUECKGEWIESEN: { ...NO_EVIDENCE, appealChain: true, decision: true },
  KLAGE: {
    ...NO_EVIDENCE,
    appealChain: true,
    decision: true,
    klage: true,
  },
  RECHTSKRAEFTIG: NO_EVIDENCE,
};

const DECISION_STATUSES = new Set<TaxNoticeStatus>(['TEILABHILFE', 'ZURUECKGEWIESEN']);

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
  const decisionReceivedAt =
    before.appealDecisionReceivedAt ??
    (isDecisionStatus ? request.eventDate : request.legacyDecisionReceivedAt);

  return {
    appealFiledAt,
    appealFiledBy:
      before.appealFiledBy ??
      (request.status === 'EINSPRUCH' || request.legacyAppealFiledAt ? staffId : null),
    decisionReceivedAt,
    decisionInstructionValid:
      before.appealDecisionLegalRemedyInstructionValid ??
      request.decisionLegalRemedyInstructionValid,
    appealResolvedAt:
      request.legacyAppealResolvedAt ??
      (request.legacyDecisionReceivedAt && requirements.decision
        ? request.legacyDecisionReceivedAt
        : (before.appealResolvedAt ??
          (request.status === 'ABGEHOLFEN' || isDecisionStatus
            ? request.eventDate
            : decisionReceivedAt))),
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

function validateProcedureEventOrder(
  before: NoticeTransitionSource,
  evidence: EffectiveEvidence,
): NoticeTransitionFailure | null {
  if (evidence.appealFiledAt && startOfUtcDay(evidence.appealFiledAt) < before.noticeDate) {
    return invalid('Die Einspruchseinlegung darf nicht vor dem Bescheiddatum liegen.');
  }
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
  if (request.status !== 'RECHTSKRAEFTIG' || !request.eventDate) return null;
  const priorEvents = [
    before.noticeDate,
    evidence.appealFiledAt ? startOfUtcDay(evidence.appealFiledAt) : null,
    evidence.appealResolvedAt ? startOfUtcDay(evidence.appealResolvedAt) : null,
    evidence.decisionReceivedAt,
    evidence.klageFiledAt ? startOfUtcDay(evidence.klageFiledAt) : null,
  ].filter((date): date is Date => date !== null);
  const latestPriorEvent = priorEvents.reduce(
    (latest, date) => (date > latest ? date : latest),
    before.noticeDate,
  );

  return request.eventDate < latestPriorEvent
    ? invalid(
        'Der Eintritt der Rechtskraft darf nicht vor einem dokumentierten Verfahrensereignis liegen.',
      )
    : null;
}

function calculateKlageDeadline(
  before: NoticeTransitionSource,
  evidence: EffectiveEvidence,
  region: GermanRegion | null,
): Date | null {
  if (!evidence.decisionReceivedAt || evidence.decisionInstructionValid === null) return null;
  return (
    before.klageDeadline ??
    klageDeadline(evidence.decisionReceivedAt, region, evidence.decisionInstructionValid)
  );
}

function buildDecisionUpdate(context: TransitionContext): Prisma.TaxNoticeUpdateManyMutationInput {
  return {
    status: context.request.status,
    appealResolvedAt: context.request.eventDate,
    appealDecisionReceivedAt: context.request.eventDate,
    appealDecisionLegalRemedyInstructionValid: context.request.decisionLegalRemedyInstructionValid,
    klageDeadline: context.klageFrist,
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
  ABGEHOLFEN: ({ request }) => ({
    status: 'ABGEHOLFEN',
    appealResolvedAt: request.eventDate,
  }),
  TEILABHILFE: buildDecisionUpdate,
  ZURUECKGEWIESEN: buildDecisionUpdate,
  KLAGE: ({ request, staffId }) => ({
    status: 'KLAGE',
    klageFiledAt: request.eventDate,
    klageFiledBy: staffId,
  }),
  RECHTSKRAEFTIG: ({ request, staffId }) => ({
    status: 'RECHTSKRAEFTIG',
    legalFinalAt: request.eventDate,
    legalFinalBy: staffId,
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
  const { before, request, region } = arguments_;
  const transitionFailure = validateTransition(before, request.status);
  if (transitionFailure) return transitionFailure;

  const requirements = SOURCE_EVIDENCE_RULES[before.status];
  const legacyFailure =
    validateLegacyScope(request, requirements) ?? validateLegacyMatches(before, request);
  if (legacyFailure) return legacyFailure;

  const evidence = deriveEffectiveEvidence(arguments_);
  const evidenceFailure =
    validateRequiredEvidence(evidence, requirements) ??
    validateProcedureEventOrder(before, evidence) ??
    validateLegalFinalOrder(before, request, evidence);
  if (evidenceFailure) return evidenceFailure;

  const klageFrist = calculateKlageDeadline(before, evidence, region);
  const context = { ...arguments_, evidence, klageFrist };

  return {
    ok: true,
    data: {
      ...STATUS_UPDATE_BUILDERS[request.status](context),
      ...buildLegacyEvidenceUpdate(context),
    },
    auditAfter: {
      status: request.status,
      eventDate: request.eventDateInput ?? null,
      klageDeadline: klageFrist?.toISOString().slice(0, 10) ?? null,
      decisionLegalRemedyInstructionValid: request.decisionLegalRemedyInstructionValid,
      legacyEvidenceConfirmed: request.legacyEvidence ?? null,
    },
  };
}
