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

    // Wie die Datenbank (app.legal_final_reason_sufficient) zählt die Prüfung
    // Codepoints: fünf Emoji sind zehn UTF-16-Einheiten, aber nur fünf Zeichen.
    const emojiReason = request('BESTANDSKRAEFTIG', '2026-02-11');
    emojiReason.legalFinalReason = '\u{1F4DD}'.repeat(5);
    expect(plan(before, emojiReason)).toMatchObject({
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

  // Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001 — Produktentscheidung A3
  // (2026-10-07): Gespeicherte Verfahrenszeitpunkte zählen mit ihrem Berliner
  // Kalendertag; die Frist endet mit Ablauf ihres letzten Tages (§ 108 Abs. 1 AO
  // i. V. m. § 188 BGB). Formularwerte (UTC-Mitternacht) behalten ihren Tag.
  describe('Berliner Kalendertag gespeicherter Verfahrenszeitpunkte', () => {
    function eingelegt(appealFiledAt: string, appealDeadline: string): NoticeTransitionSource {
      const before = source('EINSPRUCH');
      before.appealDeadline = new Date(`${appealDeadline}T00:00:00.000Z`);
      before.appealFiledAt = new Date(appealFiledAt);
      before.appealFiledBy = actorId;
      return before;
    }

    it.each([
      ['Winter, 23:30 MEZ am Fristtag', '2026-02-10T22:30:00.000Z', '2026-02-10', 'TIMELY'],
      ['Winter, 00:30 MEZ am Folgetag', '2026-02-10T23:30:00.000Z', '2026-02-10', 'LATE'],
      ['Sommer, 23:30 MESZ am Fristtag', '2026-07-15T21:30:00.000Z', '2026-07-15', 'TIMELY'],
      ['Sommer, 00:30 MESZ am Folgetag', '2026-07-15T22:30:00.000Z', '2026-07-15', 'LATE'],
      ['00:00 UTC am Fristtag', '2026-07-15T00:00:00.000Z', '2026-07-15', 'TIMELY'],
      ['00:00 UTC am Folgetag', '2026-07-16T00:00:00.000Z', '2026-07-15', 'LATE'],
      ['29.03., 23:59 MESZ', '2026-03-29T21:59:59.999Z', '2026-03-29', 'TIMELY'],
      ['30.03., 00:00 MESZ', '2026-03-29T22:00:00.000Z', '2026-03-29', 'LATE'],
      ['25.10., 23:59 MEZ', '2026-10-25T22:59:59.999Z', '2026-10-25', 'TIMELY'],
      ['26.10., 00:00 MEZ', '2026-10-25T23:00:00.000Z', '2026-10-25', 'LATE'],
    ])('dokumentiert die Einlegung %s als %s', (_name, filedAt, deadline, timeliness) => {
      const result = plan(eingelegt(filedAt, deadline), request('ABGEHOLFEN', '2026-11-30'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.auditAfter.appealFilingTimeliness).toBe(
        timeliness === 'TIMELY' ? 'TIMELY' : 'LATE_REVIEW_REQUIRED',
      );
    });

    it('prüft den bestätigten Altbestandstag gegen den Berliner Tag der Einlegung', () => {
      // 23:30 Uhr UTC am 20.01. ist 00:30 Uhr MEZ am 21.01.
      const before = source('EINSPRUCH');
      before.appealFiledAt = new Date('2026-01-20T23:30:00.000Z');
      const transition = (appealFiledDate: string) => {
        const next = request('ABGEHOLFEN', '2026-02-02');
        next.legacyEvidence = { appealFiledDate };
        next.legacyAppealFiledAt = new Date(`${appealFiledDate}T00:00:00.000Z`);
        return next;
      };

      expect(plan(before, transition('2026-01-20'))).toMatchObject({
        ok: false,
        error: 'Der bestätigte Einspruchstag weicht vom Bestandsdatum ab.',
      });
      expect(plan(before, transition('2026-01-21'))).toMatchObject({
        ok: true,
        data: { status: 'ABGEHOLFEN', appealFiledBy: actorId },
      });
    });

    it('ordnet Bescheiddatum und Teilabhilfe nach dem Berliner Tag der Einlegung', () => {
      const before = eingelegt('2026-02-04T23:30:00.000Z', '2026-03-10'); // 00:30 MEZ am 05.02.
      before.noticeDate = new Date('2026-02-05T00:00:00.000Z');

      expect(plan(before, request('TEILABHILFE', '2026-02-04'))).toMatchObject({
        ok: false,
        error: 'Die Bekanntgabe der Teilabhilfe darf nicht vor der Einspruchseinlegung liegen.',
      });
      expect(plan(before, request('TEILABHILFE', '2026-02-05'))).toMatchObject({ ok: true });

      // 23:30 Uhr MEZ am 04.02. liegt vor dem Bescheiddatum.
      const zuFrueh = eingelegt('2026-02-04T22:30:00.000Z', '2026-03-10');
      zuFrueh.noticeDate = new Date('2026-02-05T00:00:00.000Z');
      expect(plan(zuFrueh, request('ABGEHOLFEN', '2026-02-20'))).toMatchObject({
        ok: false,
        error: 'Die Einspruchseinlegung darf nicht vor dem Bescheiddatum liegen.',
      });
    });

    it('stellt Bestandskraft nicht vor dem Berliner Tag der Klageeinreichung fest', () => {
      const before = source('KLAGE');
      before.appealFiledAt = new Date('2026-01-20T00:00:00.000Z');
      before.appealFiledBy = actorId;
      before.appealResolvedAt = new Date('2026-02-02T00:00:00.000Z');
      before.appealDecisionReceivedAt = new Date('2026-02-02T00:00:00.000Z');
      before.appealDecisionLegalRemedyInstructionValid = true;
      before.klageDeadline = new Date('2026-03-02T00:00:00.000Z');
      // 23:30 Uhr UTC am 02.03. ist 00:30 Uhr MEZ am 03.03., nach dem Fristende.
      before.klageFiledAt = new Date('2026-03-02T23:30:00.000Z');
      before.klageFiledBy = actorId;

      expect(plan(before, request('BESTANDSKRAEFTIG', '2026-03-02'))).toMatchObject({
        ok: false,
        error:
          'Der Eintritt der Bestandskraft darf nicht vor einem dokumentierten Verfahrensereignis liegen.',
      });
      const result = plan(before, request('BESTANDSKRAEFTIG', '2026-03-03'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.auditAfter.klageFilingTimeliness).toBe('LATE_REVIEW_REQUIRED');
    });
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
