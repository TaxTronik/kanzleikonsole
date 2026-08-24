import { describe, expect, it } from 'vitest';
import type { TaxNoticeStatus } from '@prisma/client';
import type { HolidayLocationContext } from '@taxtronik/tax';
import {
  planNoticeTransition,
  type NoticeTransitionRequest,
  type NoticeTransitionSource,
} from '../notice-transition';
import { NOTICE_STATUS_TRANSITIONS } from '../transitions';

const actorId = '11111111-1111-4111-8111-111111111111';

function source(status: TaxNoticeStatus): NoticeTransitionSource {
  return {
    status,
    noticeDate: new Date('2026-01-10T00:00:00.000Z'),
    appealDeadline: new Date('2026-02-10T00:00:00.000Z'),
    deadlineCalculationStatus: 'CALCULATED',
    manualReviewRequired: false,
    reviewedAt: null,
    appealFiledAt: null,
    appealFiledBy: null,
    partialReliefReceivedAt: null,
    partialReliefReceivedBy: null,
    appealResolvedAt: null,
    appealDecisionReceivedAt: null,
    appealDecisionLegalRemedyInstructionValid: null,
    klageDeadline: null,
    klageFiledAt: null,
    klageFiledBy: null,
  };
}

function request(status: TaxNoticeStatus, eventDateInput?: string): NoticeTransitionRequest {
  return {
    status,
    eventDateInput,
    eventDate: eventDateInput ? new Date(`${eventDateInput}T00:00:00.000Z`) : null,
    decisionLegalRemedyInstructionValid: null,
    legalFinalReason:
      status === 'BESTANDSKRAEFTIG' ? 'Aktenlage und Fristablauf fachlich geprüft.' : null,
    legacyAppealFiledAt: null,
    legacyAppealResolvedAt: null,
    legacyPartialReliefReceivedAt: null,
    legacyDecisionReceivedAt: null,
    legacyKlageFiledAt: null,
  };
}

function plan(
  before: NoticeTransitionSource,
  transition: NoticeTransitionRequest,
  deadlineHolidayContext: HolidayLocationContext = {
    countryCode: 'DE' as const,
    region: 'DE-BE' as const,
    locality: 'Berlin',
    calendarStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION' as const,
    localHolidays: [] as Date[],
  },
) {
  return planNoticeTransition({
    before,
    request: transition,
    staffId: actorId,
    now: new Date('2026-02-01T10:00:00.000Z'),
    deadlineHolidayContext,
  });
}

describe('Bescheid-Statusautomat', () => {
  // Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
  it('plant einen direkten Einspruch inklusive Prüf- und Ereignisnachweis', () => {
    const result = plan(source('NEU'), request('EINSPRUCH', '2026-02-01'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'EINSPRUCH',
      reviewedBy: actorId,
      appealFiledBy: actorId,
      appealFiledAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(result.auditAfter).toMatchObject({
      status: 'EINSPRUCH',
      eventDateRecorded: true,
    });
    expect(JSON.stringify(result.auditAfter)).not.toContain('2026-02-01');
  });

  it('weist tabellenfremde Rücktransitionen zurück', () => {
    const result = plan(source('BESTANDSKRAEFTIG'), request('NEU'));

    expect(result).toEqual({
      ok: false,
      error: 'Statuswechsel BESTANDSKRAEFTIG → NEU ist nicht zulässig.',
    });
  });

  it('akzeptiert Altbestandsnachweise nur im passenden Verfahrenszustand', () => {
    const transition = request('BESTANDSKRAEFTIG', '2026-02-01');
    transition.legacyEvidence = { appealFiledDate: '2026-01-20' };
    transition.legacyAppealFiledAt = new Date('2026-01-20T00:00:00.000Z');

    expect(plan(source('GEPRUEFT'), transition)).toMatchObject({
      ok: false,
      error: 'Der übermittelte Altbestandsnachweis passt nicht zum aktuellen Verfahren.',
    });
  });

  it('lässt ein bereits dokumentiertes Erledigungsdatum nicht per Altbestand überschreiben', () => {
    const before = source('ABGEHOLFEN');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    before.appealResolvedAt = new Date('2026-02-02T00:00:00.000Z');
    const transition = request('BESTANDSKRAEFTIG', '2026-02-10');
    transition.legacyEvidence = { appealResolvedDate: '2026-01-25' };
    transition.legacyAppealResolvedAt = new Date('2026-01-25T00:00:00.000Z');

    expect(plan(before, transition)).toMatchObject({
      ok: false,
      error: 'Der bestätigte Erledigungs- oder Abhilfetag weicht vom Bestandsdatum ab.',
    });
  });

  it('dokumentiert verspätete Einlegung als offenen Prüffall statt als fristgerecht', () => {
    const result = plan(source('GEPRUEFT'), request('EINSPRUCH', '2026-02-11'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.auditAfter).toMatchObject({
      appealFilingTimeliness: 'LATE_REVIEW_REQUIRED',
    });
  });

  it('blockiert Bestandskraft vor einem dokumentierten Ereignis', () => {
    const before = source('GEPRUEFT');
    before.noticeDate = new Date('2026-02-10T00:00:00.000Z');

    expect(plan(before, request('BESTANDSKRAEFTIG', '2026-02-01'))).toMatchObject({
      ok: false,
      error:
        'Der Eintritt der Bestandskraft darf nicht vor einem dokumentierten Verfahrensereignis liegen.',
    });
  });

  it('verlangt für Bestandskraft Fristablauf, belastbare Berechnung und Begründung', () => {
    const before = source('GEPRUEFT');
    const tooEarly = request('BESTANDSKRAEFTIG', '2026-02-10');
    expect(plan(before, tooEarly)).toMatchObject({
      ok: false,
      error: 'Bestandskraft darf erst nach Ablauf der Einspruchsfrist festgestellt werden.',
    });

    const withoutReason = request('BESTANDSKRAEFTIG', '2026-02-11');
    withoutReason.legalFinalReason = null;
    expect(plan(before, withoutReason)).toMatchObject({
      ok: false,
      error:
        'Die fachliche Abschlussentscheidung zur Bestandskraft muss nachvollziehbar begründet werden.',
    });

    const withReason = request('BESTANDSKRAEFTIG', '2026-02-11');
    const successful = plan(before, withReason);
    expect(successful.ok).toBe(true);
    if (successful.ok) {
      expect(successful.auditAfter).toMatchObject({ legalFinalReasonRecorded: true });
      expect(JSON.stringify(successful.auditAfter)).not.toContain(withReason.legalFinalReason!);
    }

    before.manualReviewRequired = true;
    expect(plan(before, request('BESTANDSKRAEFTIG', '2026-02-11'))).toMatchObject({
      ok: false,
      error:
        'Bestandskraft darf erst nach einer vollständig berechneten und fachlich geprüften Einspruchsfrist festgestellt werden.',
    });
  });

  it('lässt Bestandskraft nach Zurückweisung frühestens am Tag nach der Klagefrist zu', () => {
    const before = source('ZURUECKGEWIESEN');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    before.appealResolvedAt = new Date('2026-02-02T00:00:00.000Z');
    before.appealDecisionReceivedAt = new Date('2026-02-02T00:00:00.000Z');
    before.appealDecisionLegalRemedyInstructionValid = true;
    before.klageDeadline = new Date('2026-03-02T00:00:00.000Z');

    expect(plan(before, request('BESTANDSKRAEFTIG', '2026-03-02'))).toMatchObject({
      ok: false,
      error:
        'Bestandskraft darf erst nach Ablauf der dokumentierten Klagefrist festgestellt werden.',
    });

    expect(plan(before, request('BESTANDSKRAEFTIG', '2026-03-03'))).toMatchObject({
      ok: true,
      data: { status: 'BESTANDSKRAEFTIG' },
    });
  });

  it('behandelt TEILABHILFE nicht als Einspruchsentscheidung und erzeugt keine Klagefrist', () => {
    const before = source('EINSPRUCH');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;

    const result = plan(before, request('TEILABHILFE', '2026-02-02'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'TEILABHILFE',
      partialReliefReceivedAt: new Date('2026-02-02T00:00:00.000Z'),
      partialReliefReceivedBy: actorId,
      appealResolvedAt: null,
      appealDecisionReceivedAt: null,
      appealDecisionLegalRemedyInstructionValid: null,
      klageDeadline: null,
    });
    expect(result.auditAfter).toMatchObject({
      partialReliefReceiptRecorded: true,
      klageDeadlineCalculated: false,
    });
    expect(JSON.stringify(result.auditAfter)).not.toContain('2026-02-02');
  });

  // Fachkatalog: TAX-CONTROL-STATUS-001, TAX-NOTICE-APPEAL-001
  it('weist eine Teilabhilfe vor der dokumentierten Einspruchseinlegung zurück', () => {
    const before = source('EINSPRUCH');
    before.appealFiledAt = new Date('2026-02-05T00:00:00.000Z');
    before.appealFiledBy = actorId;

    expect(plan(before, request('TEILABHILFE', '2026-02-04'))).toMatchObject({
      ok: false,
      error: 'Die Bekanntgabe der Teilabhilfe darf nicht vor der Einspruchseinlegung liegen.',
    });
  });

  it('blockiert den Folgeübergang bei einer Teilabhilfe ohne eigenen Ereignisnachweis', () => {
    const before = source('TEILABHILFE');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;

    expect(plan(before, request('ABGEHOLFEN', '2026-02-10'))).toMatchObject({
      ok: false,
      error:
        'Bekanntgabetag und dokumentierende Person der Teilabhilfe müssen zuerst bestätigt werden.',
    });
  });

  it('ergänzt den ausdrücklich bestätigten Teilabhilfe-Nachweis eines Altbestands', () => {
    const before = source('TEILABHILFE');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    const transition = request('ABGEHOLFEN', '2026-02-10');
    transition.legacyEvidence = { partialReliefReceivedDate: '2026-02-02' };
    transition.legacyPartialReliefReceivedAt = new Date('2026-02-02T00:00:00.000Z');

    const result = plan(before, transition);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'ABGEHOLFEN',
      partialReliefReceivedAt: new Date('2026-02-02T00:00:00.000Z'),
      partialReliefReceivedBy: actorId,
    });
    expect(result.auditAfter.partialReliefReceiptRecorded).toBe(true);
    expect(result.auditAfter.legacyEvidenceFieldsConfirmed).toContain('partialReliefReceivedDate');
    expect(JSON.stringify(result.auditAfter)).not.toContain('2026-02-02');
  });

  it('weist eine Einspruchsentscheidung vor der dokumentierten Teilabhilfe zurück', () => {
    const before = source('TEILABHILFE');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    before.partialReliefReceivedAt = new Date('2026-02-10T00:00:00.000Z');
    before.partialReliefReceivedBy = actorId;
    const transition = request('ZURUECKGEWIESEN', '2026-02-09');
    transition.decisionLegalRemedyInstructionValid = true;

    expect(plan(before, transition)).toMatchObject({
      ok: false,
      error: 'Die Bekanntgabe der Einspruchsentscheidung darf nicht vor der Teilabhilfe liegen.',
    });
  });

  it('lässt nach TEILABHILFE nur die Fortsetzung des Einspruchsverfahrens zu', () => {
    expect(NOTICE_STATUS_TRANSITIONS.TEILABHILFE).toEqual([
      'ABGEHOLFEN',
      'TEILEINSPRUCHSENTSCHEIDUNG',
      'ZURUECKGEWIESEN',
    ]);
  });

  it('trennt eine Teil-Einspruchsentscheidung von der Teilabhilfe', () => {
    const before = source('EINSPRUCH');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    const transition = request('TEILEINSPRUCHSENTSCHEIDUNG', '2026-02-02');
    transition.decisionLegalRemedyInstructionValid = true;

    const result = plan(before, transition);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'TEILEINSPRUCHSENTSCHEIDUNG',
      appealResolvedAt: null,
      appealDecisionReceivedAt: new Date('2026-02-02T00:00:00.000Z'),
    });
    expect(result.data.klageDeadline).toBeInstanceOf(Date);
  });

  it('berücksichtigt beim Klagefristende den geprüften örtlichen Behördenfeiertag', () => {
    const before = source('EINSPRUCH');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    const transition = request('ZURUECKGEWIESEN', '2026-02-02');
    transition.decisionLegalRemedyInstructionValid = true;

    const result = plan(before, transition, {
      countryCode: 'DE',
      region: 'DE-BE',
      locality: 'Berlin',
      calendarStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION',
      localHolidays: [new Date('2026-03-02T00:00:00.000Z')],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.klageDeadline).toEqual(new Date('2026-03-03T00:00:00.000Z'));
  });

  it('blockiert eine neue Einspruchsentscheidung bei ungeprüftem Behördenkalender', () => {
    const before = source('EINSPRUCH');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    const transition = request('ZURUECKGEWIESEN', '2026-02-02');
    transition.decisionLegalRemedyInstructionValid = true;

    expect(
      plan(before, transition, {
        countryCode: 'DE',
        region: null,
        locality: null,
        calendarStatus: 'UNKNOWN',
      }),
    ).toMatchObject({
      ok: false,
      error:
        'Die Klagefrist kann ohne vollständig geprüften Feiertagskontext des Behördensitzes nicht festgelegt werden.',
    });
  });

  it('ersetzt bei späterer Einspruchsentscheidung fehlerhafte Teilabhilfe-Altdaten', () => {
    const before = source('TEILABHILFE');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    before.partialReliefReceivedAt = new Date('2026-02-02T00:00:00.000Z');
    before.partialReliefReceivedBy = actorId;
    before.appealResolvedAt = new Date('2026-02-02T00:00:00.000Z');
    before.appealDecisionReceivedAt = new Date('2026-02-02T00:00:00.000Z');
    before.appealDecisionLegalRemedyInstructionValid = true;
    before.klageDeadline = new Date('2026-03-02T00:00:00.000Z');
    const transition = request('ZURUECKGEWIESEN', '2026-02-10');
    transition.decisionLegalRemedyInstructionValid = true;

    const result = plan(before, transition);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.appealDecisionReceivedAt).toEqual(new Date('2026-02-10T00:00:00.000Z'));
    expect(result.data.klageDeadline).not.toEqual(new Date('2026-03-02T00:00:00.000Z'));
  });

  it('berechnet die Klagefrist aus bestätigtem Entscheidungszugang', () => {
    const before = source('EINSPRUCH');
    before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
    before.appealFiledBy = actorId;
    const transition = request('ZURUECKGEWIESEN', '2026-02-02');
    transition.decisionLegalRemedyInstructionValid = true;

    const result = plan(before, transition);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'ZURUECKGEWIESEN',
      appealDecisionReceivedAt: new Date('2026-02-02T00:00:00.000Z'),
      appealDecisionLegalRemedyInstructionValid: true,
    });
    expect(result.data.klageDeadline).toBeInstanceOf(Date);
  });
});
