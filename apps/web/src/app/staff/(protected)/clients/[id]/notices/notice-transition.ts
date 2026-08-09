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

function invalid(error: string): NoticeTransitionFailure {
  return { ok: false, error };
}

/**
 * Pure, table-driven transition planner. It owns the complete evidence and
 * event-order contract; the server action is limited to loading, access
 * control, compare-and-swap persistence and audit recording.
 */
export function planNoticeTransition({
  before,
  request,
  staffId,
  now,
  region,
}: {
  before: NoticeTransitionSource;
  request: NoticeTransitionRequest;
  staffId: string;
  now: Date;
  region: GermanRegion | null;
}): NoticeTransitionPlan | NoticeTransitionFailure {
  const {
    status,
    eventDate,
    eventDateInput,
    decisionLegalRemedyInstructionValid,
    legacyEvidence,
    legacyAppealFiledAt,
    legacyAppealResolvedAt,
    legacyDecisionReceivedAt,
    legacyKlageFiledAt,
  } = request;
  const allowed = NOTICE_STATUS_TRANSITIONS[before.status] ?? [];
  if (!allowed.includes(status)) {
    return invalid(`Statuswechsel ${before.status} → ${status} ist nicht zulässig.`);
  }

  const isDecisionStatus = status === 'TEILABHILFE' || status === 'ZURUECKGEWIESEN';
  const isAppealChainStatus = [
    'EINSPRUCH',
    'ABGEHOLFEN',
    'TEILABHILFE',
    'ZURUECKGEWIESEN',
    'KLAGE',
  ].includes(before.status);
  const requiresDecisionEvidence = ['TEILABHILFE', 'ZURUECKGEWIESEN', 'KLAGE'].includes(
    before.status,
  );
  const requiresKlageEvidence = before.status === 'KLAGE';
  const requiresAbhilfeEvidence = before.status === 'ABGEHOLFEN';

  if (
    (legacyAppealFiledAt && !isAppealChainStatus) ||
    (legacyAppealResolvedAt && !requiresAbhilfeEvidence) ||
    (legacyDecisionReceivedAt && !requiresDecisionEvidence) ||
    (legacyKlageFiledAt && !requiresKlageEvidence)
  ) {
    return invalid('Der übermittelte Altbestandsnachweis passt nicht zum aktuellen Verfahren.');
  }

  if (
    before.appealFiledAt &&
    legacyAppealFiledAt &&
    startOfUtcDay(before.appealFiledAt).getTime() !== legacyAppealFiledAt.getTime()
  ) {
    return invalid('Der bestätigte Einspruchstag weicht vom Bestandsdatum ab.');
  }
  if (
    before.appealDecisionReceivedAt &&
    legacyDecisionReceivedAt &&
    before.appealDecisionReceivedAt.getTime() !== legacyDecisionReceivedAt.getTime()
  ) {
    return invalid('Der bestätigte Bekanntgabetag weicht vom Bestandsdatum ab.');
  }
  if (
    before.klageFiledAt &&
    legacyKlageFiledAt &&
    startOfUtcDay(before.klageFiledAt).getTime() !== legacyKlageFiledAt.getTime()
  ) {
    return invalid('Der bestätigte Klageeinreichungstag weicht vom Bestandsdatum ab.');
  }

  const effectiveAppealFiledAt =
    before.appealFiledAt ?? (status === 'EINSPRUCH' ? eventDate : legacyAppealFiledAt);
  const effectiveAppealFiledBy =
    before.appealFiledBy ?? (status === 'EINSPRUCH' || legacyAppealFiledAt ? staffId : null);
  const effectiveDecisionReceivedAt =
    before.appealDecisionReceivedAt ?? (isDecisionStatus ? eventDate : legacyDecisionReceivedAt);
  const effectiveDecisionInstruction =
    before.appealDecisionLegalRemedyInstructionValid ?? decisionLegalRemedyInstructionValid;
  const effectiveAppealResolvedAt =
    legacyAppealResolvedAt ??
    (legacyDecisionReceivedAt && requiresDecisionEvidence
      ? legacyDecisionReceivedAt
      : (before.appealResolvedAt ??
        (status === 'ABGEHOLFEN' || isDecisionStatus ? eventDate : effectiveDecisionReceivedAt)));
  const effectiveKlageFiledAt =
    before.klageFiledAt ?? (status === 'KLAGE' ? eventDate : legacyKlageFiledAt);
  const effectiveKlageFiledBy =
    before.klageFiledBy ?? (status === 'KLAGE' || legacyKlageFiledAt ? staffId : null);

  if (isAppealChainStatus && (!effectiveAppealFiledAt || !effectiveAppealFiledBy)) {
    return invalid(
      'Der Nachweis der tatsächlichen Einspruchseinlegung muss zuerst bestätigt werden.',
    );
  }
  if (requiresAbhilfeEvidence && !effectiveAppealResolvedAt) {
    return invalid('Der tatsächliche Bekanntgabetag der Abhilfe muss zuerst bestätigt werden.');
  }
  if (
    requiresDecisionEvidence &&
    (!effectiveDecisionReceivedAt || effectiveDecisionInstruction === null)
  ) {
    return invalid(
      'Bekanntgabetag und Rechtsbehelfsbelehrung der Einspruchsentscheidung müssen zuerst bestätigt werden.',
    );
  }
  if (requiresKlageEvidence && (!effectiveKlageFiledAt || !effectiveKlageFiledBy)) {
    return invalid('Der Nachweis der tatsächlichen Klageeinreichung muss zuerst bestätigt werden.');
  }

  if (effectiveAppealFiledAt && startOfUtcDay(effectiveAppealFiledAt) < before.noticeDate) {
    return invalid('Die Einspruchseinlegung darf nicht vor dem Bescheiddatum liegen.');
  }
  if (
    effectiveAppealResolvedAt &&
    effectiveAppealFiledAt &&
    startOfUtcDay(effectiveAppealResolvedAt) < startOfUtcDay(effectiveAppealFiledAt)
  ) {
    return invalid(
      'Die Bekanntgabe der Einspruchsentscheidung darf nicht vor der Einspruchseinlegung liegen.',
    );
  }
  if (
    effectiveDecisionReceivedAt &&
    effectiveAppealFiledAt &&
    effectiveDecisionReceivedAt < startOfUtcDay(effectiveAppealFiledAt)
  ) {
    return invalid(
      'Die Bekanntgabe der Einspruchsentscheidung darf nicht vor der Einspruchseinlegung liegen.',
    );
  }
  if (
    effectiveKlageFiledAt &&
    (!effectiveDecisionReceivedAt ||
      startOfUtcDay(effectiveKlageFiledAt) < effectiveDecisionReceivedAt)
  ) {
    return invalid(
      effectiveDecisionReceivedAt
        ? 'Die Klageeinreichung darf nicht vor der Bekanntgabe der Einspruchsentscheidung liegen.'
        : 'Der tatsächliche Bekanntgabetag der Einspruchsentscheidung fehlt.',
    );
  }
  if (status === 'RECHTSKRAEFTIG' && eventDate) {
    const latestPriorEvent = [
      before.noticeDate,
      effectiveAppealFiledAt ? startOfUtcDay(effectiveAppealFiledAt) : null,
      effectiveAppealResolvedAt ? startOfUtcDay(effectiveAppealResolvedAt) : null,
      effectiveDecisionReceivedAt,
      effectiveKlageFiledAt ? startOfUtcDay(effectiveKlageFiledAt) : null,
    ]
      .filter((date): date is Date => date !== null)
      .reduce((latest, date) => (date > latest ? date : latest), before.noticeDate);
    if (eventDate < latestPriorEvent) {
      return invalid(
        'Der Eintritt der Rechtskraft darf nicht vor einem dokumentierten Verfahrensereignis liegen.',
      );
    }
  }

  const klageFrist =
    effectiveDecisionReceivedAt && effectiveDecisionInstruction !== null
      ? (before.klageDeadline ??
        klageDeadline(effectiveDecisionReceivedAt, region, effectiveDecisionInstruction))
      : null;

  return {
    ok: true,
    data: {
      status,
      ...(status === 'GEPRUEFT' ? { reviewedAt: now, reviewedBy: staffId } : {}),
      ...(status === 'NEU' ? { reviewedAt: null, reviewedBy: null } : {}),
      ...(status === 'EINSPRUCH'
        ? {
            appealFiledAt: effectiveAppealFiledAt,
            appealFiledBy: effectiveAppealFiledBy,
            ...(before.reviewedAt ? {} : { reviewedAt: now, reviewedBy: staffId }),
          }
        : {}),
      ...(legacyAppealFiledAt
        ? { appealFiledAt: effectiveAppealFiledAt, appealFiledBy: effectiveAppealFiledBy }
        : {}),
      ...(status === 'ABGEHOLFEN' || isDecisionStatus ? { appealResolvedAt: eventDate } : {}),
      ...(legacyAppealResolvedAt || legacyDecisionReceivedAt
        ? { appealResolvedAt: effectiveAppealResolvedAt }
        : {}),
      ...(isDecisionStatus
        ? {
            appealDecisionReceivedAt: eventDate,
            appealDecisionLegalRemedyInstructionValid: decisionLegalRemedyInstructionValid,
            klageDeadline: klageFrist,
          }
        : {}),
      ...(legacyDecisionReceivedAt
        ? {
            appealDecisionReceivedAt: effectiveDecisionReceivedAt,
            appealDecisionLegalRemedyInstructionValid: effectiveDecisionInstruction,
            klageDeadline: klageFrist,
          }
        : {}),
      ...(status === 'RECHTSKRAEFTIG' ? { legalFinalAt: eventDate, legalFinalBy: staffId } : {}),
      ...(status === 'KLAGE' ? { klageFiledAt: eventDate, klageFiledBy: staffId } : {}),
      ...(legacyKlageFiledAt
        ? { klageFiledAt: effectiveKlageFiledAt, klageFiledBy: effectiveKlageFiledBy }
        : {}),
    },
    auditAfter: {
      status,
      eventDate: eventDateInput ?? null,
      klageDeadline: klageFrist?.toISOString().slice(0, 10) ?? null,
      decisionLegalRemedyInstructionValid,
      legacyEvidenceConfirmed: legacyEvidence ?? null,
    },
  };
}
