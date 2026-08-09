import { describe, expect, it } from 'vitest';
import type { TaxNoticeStatus } from '@prisma/client';
import {
  planNoticeTransition,
  type NoticeTransitionRequest,
  type NoticeTransitionSource,
} from '../notice-transition';

const actorId = '11111111-1111-4111-8111-111111111111';

function source(status: TaxNoticeStatus): NoticeTransitionSource {
  return {
    status,
    noticeDate: new Date('2026-01-10T00:00:00.000Z'),
    reviewedAt: null,
    appealFiledAt: null,
    appealFiledBy: null,
    appealResolvedAt: null,
    appealDecisionReceivedAt: null,
    appealDecisionLegalRemedyInstructionValid: null,
    klageDeadline: null,
    klageFiledAt: null,
    klageFiledBy: null,
  };
}

function request(
  status: TaxNoticeStatus,
  eventDateInput?: string,
): NoticeTransitionRequest {
  return {
    status,
    eventDateInput,
    eventDate: eventDateInput ? new Date(`${eventDateInput}T00:00:00.000Z`) : null,
    decisionLegalRemedyInstructionValid: null,
    legacyAppealFiledAt: null,
    legacyAppealResolvedAt: null,
    legacyDecisionReceivedAt: null,
    legacyKlageFiledAt: null,
  };
}

function plan(before: NoticeTransitionSource, transition: NoticeTransitionRequest) {
  return planNoticeTransition({
    before,
    request: transition,
    staffId: actorId,
    now: new Date('2026-02-01T10:00:00.000Z'),
    region: 'DE-BE',
  });
}

describe('Bescheid-Statusautomat', () => {
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
      eventDate: '2026-02-01',
    });
  });

  it('weist tabellenfremde Rücktransitionen zurück', () => {
    const result = plan(source('RECHTSKRAEFTIG'), request('NEU'));

    expect(result).toEqual({
      ok: false,
      error: 'Statuswechsel RECHTSKRAEFTIG → NEU ist nicht zulässig.',
    });
  });

  it('akzeptiert Altbestandsnachweise nur im passenden Verfahrenszustand', () => {
    const transition = request('RECHTSKRAEFTIG', '2026-02-01');
    transition.legacyEvidence = { appealFiledDate: '2026-01-20' };
    transition.legacyAppealFiledAt = new Date('2026-01-20T00:00:00.000Z');

    expect(plan(source('GEPRUEFT'), transition)).toMatchObject({
      ok: false,
      error: 'Der übermittelte Altbestandsnachweis passt nicht zum aktuellen Verfahren.',
    });
  });

  it('blockiert Rechtskraft vor einem dokumentierten Ereignis', () => {
    const before = source('GEPRUEFT');
    before.noticeDate = new Date('2026-02-10T00:00:00.000Z');

    expect(plan(before, request('RECHTSKRAEFTIG', '2026-02-01'))).toMatchObject({
      ok: false,
      error:
        'Der Eintritt der Rechtskraft darf nicht vor einem dokumentierten Verfahrensereignis liegen.',
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
