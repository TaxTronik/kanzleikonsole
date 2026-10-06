// Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-NOTICE-DATARETRIEVAL-001, TAX-CONTROL-STATUS-001
// Review-Befund K-04: Zeilenmodell der Bescheidliste — Fristtage, Dringlichkeit,
// Badges, Klagefrist-Erledigung und Nachweise rein aus dem gespeicherten
// Bescheid. Die Fristen selbst werden nicht neu berechnet.

import { describe, expect, it } from 'vitest';
import { fmtDateShort, fmtEUR } from '@/lib/fmt';
import {
  amountDelta,
  daysUntil,
  deadlineVm,
  klageDeadlineVm,
  noticeStatusEvidence,
  noticeStatusVm,
  reviewReasons,
  toNoticeRowVm,
  type NoticeRowInput,
} from '../notice-row-vm';

const TODAY = new Date('2026-10-06T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function inDays(days: number): Date {
  return new Date(TODAY.getTime() + days * DAY);
}

function notice(overrides: Partial<NoticeRowInput> = {}): NoticeRowInput {
  return {
    id: 'notice-1',
    kind: 'EST',
    period: '2025',
    fileNumber: null,
    noticeDate: new Date('2026-09-01T00:00:00.000Z'),
    deliveryMethod: 'POST',
    dateBasis: 'DISPATCH_DATE',
    legalRemedyInstructionStatus: 'WIRKSAM',
    retrievalIssuedAt: null,
    retrievalNotificationDate: null,
    retrievalNotificationLegacyFallback: false,
    retrievalNotificationDisputedOrLate: false,
    retrievedAt: null,
    retrievalConsentStatus: 'NOT_APPLICABLE',
    retrievalEligibility2027Status: 'NOT_APPLICABLE',
    retrievalPostalRequestStatus: 'NOT_APPLICABLE',
    retrievalPostalRequestReceivedAt: null,
    retrievalNotificationStatus: 'NOT_RECORDED',
    retrievalReinstatementReviewRequired: false,
    assessedAmount: null,
    expectedAmount: null,
    deadlineCalculationStatus: 'CALCULATED',
    appealDeadline: inDays(20),
    internalRiskDeadline: null,
    alternativeClaimedAccessDeadline: null,
    manualReviewRequired: false,
    manualReviewReason: null,
    status: 'NEU',
    appealFiledAt: null,
    appealFiledBy: null,
    appealResolvedAt: null,
    partialReliefReceivedAt: null,
    partialReliefReceivedBy: null,
    appealDecisionReceivedAt: null,
    appealDecisionLegalRemedyInstructionValid: null,
    klageDeadline: null,
    klageFiledAt: null,
    klageFiledBy: null,
    legalFinalAt: null,
    legalFinalBy: null,
    legalFinalReason: null,
    document: null,
    filing: null,
    ...overrides,
  };
}

const decimal = (value: string) => ({ toString: () => value });

describe('daysUntil', () => {
  it.each([
    [inDays(0), 0],
    [inDays(7), 7],
    [inDays(-1), -1],
    // Sommerzeit-Stunden runden auf ganze Kalendertage.
    [new Date(TODAY.getTime() + 2 * DAY - 60 * 60 * 1000), 2],
  ])('%s → %i', (date, expected) => {
    expect(daysUntil(date, TODAY)).toBe(expected);
  });
});

describe('Einspruchsfrist (Kontrollvorschlag)', () => {
  it.each([
    ['in 20 Tagen', 20, false, 'noch 20 Tage', false],
    ['in 8 Tagen', 8, false, 'noch 8 Tage', false],
    ['in 7 Tagen', 7, false, 'noch 7 Tage', true],
    ['heute', 0, false, 'noch 0 Tage', true],
    ['seit 3 Tagen abgelaufen', -3, false, '3 Tage abgelaufen', true],
    ['mit offener fachlicher Freigabe', 30, true, 'noch 30 Tage', false],
  ])('%s', (_name, days, reviewOpen, daysLabel, urgent) => {
    const vm = deadlineVm(
      notice({ appealDeadline: inDays(days), manualReviewRequired: reviewOpen }),
      TODAY,
    );

    expect(vm.calculated).toEqual({
      reviewOpen,
      date: fmtDateShort(inDays(days)),
      daysLeft: days,
      daysLabel,
      urgent,
    });
    expect(vm).toMatchObject({
      legacyDate: null,
      riskDate: null,
      manualReview: false,
      legacyUnassessed: false,
    });
  });

  it('zeigt ohne gespeicherte Frist keinen Kontrollvorschlag', () => {
    expect(deadlineVm(notice({ appealDeadline: null }), TODAY).calculated).toBeNull();
  });
});

describe('Fristen ohne berechneten Kontrollvorschlag', () => {
  it('führt den internen Risikotermin ausdrücklich nicht als Rechtsfrist', () => {
    const vm = deadlineVm(
      notice({
        deadlineCalculationStatus: 'RISK_ONLY',
        appealDeadline: null,
        internalRiskDeadline: inDays(2),
      }),
      TODAY,
    );
    expect(vm).toMatchObject({
      calculated: null,
      riskDate: fmtDateShort(inDays(2)),
      manualReview: false,
    });
  });

  it('zeigt bei manueller Prüfung beide Szenarien, alle Gründe und die Wiedereinsetzungsprüfung', () => {
    const vm = deadlineVm(
      notice({
        deadlineCalculationStatus: 'MANUAL_REVIEW',
        appealDeadline: null,
        internalRiskDeadline: inDays(3),
        alternativeClaimedAccessDeadline: inDays(12),
        manualReviewRequired: true,
        manualReviewReason: 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW, UNBEKANNT_X',
        retrievalReinstatementReviewRequired: true,
      }),
      TODAY,
    );
    expect(vm).toEqual({
      calculated: null,
      legacyDate: null,
      riskDate: null,
      manualReview: true,
      fictionScenarioDate: fmtDateShort(inDays(3)),
      claimedAccessScenarioDate: fmtDateShort(inDays(12)),
      reasons: [
        {
          key: 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW',
          label: 'behaupteter späterer Zugang ist zu würdigen',
        },
        { key: 'UNBEKANNT_X', label: 'UNBEKANNT_X' },
      ],
      reinstatementReviewRequired: true,
      legacyUnassessed: false,
    });
  });

  it.each([
    ['mit übernommener Frist', inDays(4), null, fmtDateShort(inDays(4)), false],
    ['ohne Frist und Risikotermin', null, null, null, true],
    ['nur mit Risikotermin', null, inDays(1), null, false],
  ])('Altbestand %s', (_name, appealDeadline, internalRiskDeadline, legacyDate, unassessed) => {
    const vm = deadlineVm(
      notice({
        deadlineCalculationStatus: 'LEGACY_UNVERIFIED',
        appealDeadline,
        internalRiskDeadline,
      }),
      TODAY,
    );
    expect(vm).toMatchObject({ calculated: null, legacyDate, legacyUnassessed: unassessed });
  });

  it('liest Prüfgründe getrimmt, ohne leere Einträge und in gespeicherter Reihenfolge', () => {
    expect(reviewReasons(null)).toEqual([]);
    expect(reviewReasons(' , RISK_DATE_ONLY,,HOLIDAY_LOCALITY_UNKNOWN ')).toEqual([
      { key: 'RISK_DATE_ONLY', label: 'nur Bescheiddatum als interner Risikobezug vorhanden' },
      { key: 'HOLIDAY_LOCALITY_UNKNOWN', label: 'konkreter Feiertagsort ist nicht dokumentiert' },
    ]);
  });
});

describe('Verfahrensstatus', () => {
  it.each([
    ['NEU', 'badge-yellow', 'Neu', true],
    ['GEPRUEFT', 'badge-green', 'Geprüft', true],
    ['EINSPRUCH', 'badge-yellow', 'Einspruch eingelegt', true],
    ['ABGEHOLFEN', 'badge-green', 'Einspruch abgeholfen', true],
    ['TEILABHILFE', 'badge-yellow', 'Teilweise abgeholfen', true],
    ['TEILEINSPRUCHSENTSCHEIDUNG', 'badge-red', 'Teil-Einspruchsentscheidung', false],
    ['ZURUECKGEWIESEN', 'badge-red', 'Einspruch zurückgewiesen', false],
    ['KLAGE', 'badge-red', 'Klage beim Finanzgericht', false],
    ['BESTANDSKRAEFTIG', 'badge-gray', 'Bestandskräftig', false],
  ])('%s → %s', (status, className, label, beforePartialRelief) => {
    expect(noticeStatusVm(notice({ status }), TODAY).badge).toEqual({
      className,
      label,
      beforePartialRelief,
    });
  });

  it('zeigt einen unbekannten Status ohne Badge', () => {
    expect(noticeStatusVm(notice({ status: 'UNBEKANNT' }), TODAY).badge).toBeNull();
  });

  it('zeigt Entscheidung und Belehrungsmangel erst nach einer Einspruchsentscheidung', () => {
    const decided = {
      partialReliefReceivedAt: inDays(-30),
      appealDecisionReceivedAt: inDays(-10),
      appealDecisionLegalRemedyInstructionValid: false,
    };
    expect(noticeStatusVm(notice({ status: 'ZURUECKGEWIESEN', ...decided }), TODAY)).toMatchObject({
      partialReliefDate: fmtDateShort(inDays(-30)),
      appealDecisionDate: fmtDateShort(inDays(-10)),
      decisionInstructionMissing: true,
    });
    // Teilabhilfe: Nachweis bleibt sichtbar, Entscheidungsangaben nicht.
    expect(noticeStatusVm(notice({ status: 'TEILABHILFE', ...decided }), TODAY)).toMatchObject({
      partialReliefDate: fmtDateShort(inDays(-30)),
      appealDecisionDate: null,
      decisionInstructionMissing: false,
    });
  });
});

describe('Klagefrist', () => {
  const filed = { klageFiledBy: 'staff-3' };
  it.each([
    [
      'offen, Zurückweisung in 20 Tagen',
      { status: 'ZURUECKGEWIESEN', klageDeadline: inDays(20) },
      false,
      null,
    ],
    [
      'offen, Zurückweisung in 7 Tagen',
      { status: 'ZURUECKGEWIESEN', klageDeadline: inDays(7) },
      true,
      null,
    ],
    [
      'offen, Zurückweisung abgelaufen',
      { status: 'ZURUECKGEWIESEN', klageDeadline: inDays(-2) },
      true,
      null,
    ],
    [
      'Teil-Einspruchsentscheidung in 2 Tagen',
      { status: 'TEILEINSPRUCHSENTSCHEIDUNG', klageDeadline: inDays(2) },
      false,
      null,
    ],
    [
      'fristgerecht erhoben',
      { status: 'KLAGE', klageDeadline: inDays(-10), klageFiledAt: inDays(-12), ...filed },
      false,
      ' · erledigt',
    ],
    [
      'am Fristtag erhoben',
      { status: 'KLAGE', klageDeadline: inDays(-10), klageFiledAt: inDays(-10), ...filed },
      false,
      ' · erledigt',
    ],
    [
      'verspätet erhoben',
      { status: 'KLAGE', klageDeadline: inDays(-10), klageFiledAt: inDays(-5), ...filed },
      false,
      ' · Einreichung dokumentiert, Fristkontrolle offen',
    ],
    [
      'Einreichung ohne handelnde Person',
      { status: 'KLAGE', klageDeadline: inDays(-10), klageFiledAt: inDays(-12) },
      false,
      null,
    ],
    [
      'bestandskräftig mit Disposition',
      {
        status: 'BESTANDSKRAEFTIG',
        klageDeadline: inDays(-30),
        legalFinalAt: inDays(-1),
        legalFinalBy: 'staff-4',
        legalFinalReason: 'Klage nicht erhoben',
      },
      false,
      ' · erledigt',
    ],
    [
      'bestandskräftig ohne Begründung',
      {
        status: 'BESTANDSKRAEFTIG',
        klageDeadline: inDays(-30),
        legalFinalAt: inDays(-1),
        legalFinalBy: 'staff-4',
        legalFinalReason: '   ',
      },
      false,
      ' · Abschlussnachweis unvollständig',
    ],
  ] as Array<[string, Partial<NoticeRowInput>, boolean, string | null]>)(
    '%s',
    (_name, overrides, urgent, suffix) => {
      const klage = klageDeadlineVm(notice(overrides), TODAY);
      expect(klage).toEqual({
        date: fmtDateShort(overrides.klageDeadline!),
        daysLeft: daysUntil(overrides.klageDeadline!, TODAY),
        urgent,
        suffix,
      });
    },
  );

  it('zeigt bei Teilabhilfe und ohne Klagefrist keine Klagefrist', () => {
    expect(
      klageDeadlineVm(notice({ status: 'TEILABHILFE', klageDeadline: inDays(3) }), TODAY),
    ).toBeNull();
    expect(klageDeadlineVm(notice({ status: 'ZURUECKGEWIESEN' }), TODAY)).toBeNull();
  });
});

describe('Nachweise für die Status-Auswahl', () => {
  it('meldet fehlende Paare und Datumsstände als ISO-Tag', () => {
    expect(noticeStatusEvidence(notice())).toEqual({
      appealFiledAt: null,
      appealFiledComplete: false,
      appealResolvedAt: null,
      partialReliefReceivedAt: null,
      partialReliefComplete: false,
      decisionReceivedAt: null,
      decisionComplete: false,
      decisionInstruction: 'VALID',
      klageFiledAt: null,
      klageFiledComplete: false,
    });
    expect(
      noticeStatusEvidence(
        notice({
          appealFiledAt: new Date('2026-08-01T00:00:00.000Z'),
          appealFiledBy: 'staff-1',
          appealResolvedAt: new Date('2026-08-20T00:00:00.000Z'),
          partialReliefReceivedAt: new Date('2026-08-10T00:00:00.000Z'),
          partialReliefReceivedBy: null,
          appealDecisionReceivedAt: new Date('2026-09-01T00:00:00.000Z'),
          appealDecisionLegalRemedyInstructionValid: false,
          klageDeadline: new Date('2027-09-01T00:00:00.000Z'),
          klageFiledAt: new Date('2026-09-15T00:00:00.000Z'),
          klageFiledBy: 'staff-3',
        }),
      ),
    ).toEqual({
      appealFiledAt: '2026-08-01',
      appealFiledComplete: true,
      appealResolvedAt: '2026-08-20',
      partialReliefReceivedAt: '2026-08-10',
      partialReliefComplete: false,
      decisionReceivedAt: '2026-09-01',
      decisionComplete: true,
      decisionInstruction: 'MISSING_OR_INVALID',
      klageFiledAt: '2026-09-15',
      klageFiledComplete: true,
    });
  });

  it('verlangt für eine vollständige Entscheidung Belehrungsergebnis und Klagefrist', () => {
    const decision = { appealDecisionReceivedAt: inDays(-5) };
    expect(
      noticeStatusEvidence(notice({ ...decision, klageDeadline: inDays(25) })).decisionComplete,
    ).toBe(false);
    expect(
      noticeStatusEvidence(notice({ ...decision, appealDecisionLegalRemedyInstructionValid: true }))
        .decisionComplete,
    ).toBe(false);
  });

  it('erlaubt nur die katalogisierten Folge-Status', () => {
    expect(toNoticeRowVm(notice({ status: 'EINSPRUCH' }), TODAY).statusSelect).toMatchObject({
      noticeId: 'notice-1',
      currentStatus: 'EINSPRUCH',
      allowed: ['ABGEHOLFEN', 'TEILABHILFE', 'TEILEINSPRUCHSENTSCHEIDUNG', 'ZURUECKGEWIESEN'],
    });
    expect(toNoticeRowVm(notice({ status: 'UNBEKANNT' }), TODAY).statusSelect.allowed).toEqual([]);
  });
});

describe('Bescheid, Zugang und Beträge', () => {
  it('beschriftet Art, Aktenzeichen, Links, Zugangsweg und Datumsbasis', () => {
    const vm = toNoticeRowVm(
      notice({
        kind: 'USTA',
        fileNumber: '012/345',
        document: { id: 'doc-1' },
        filing: { sharedWithClient: true },
        deliveryMethod: 'DATA_RETRIEVAL',
        dateBasis: 'PROVISION_DATE',
        legalRemedyInstructionStatus: 'UNWIRKSAM',
      }),
      TODAY,
    );
    expect(vm).toMatchObject({
      kindLabel: 'USt-Voranmeldung',
      period: '2025',
      fileNumberSuffix: ' · Az. 012/345',
      documentHref: '/api/staff/documents/doc-1/download',
      filing: { portalShared: true },
      noticeDate: fmtDateShort(new Date('2026-09-01T00:00:00.000Z')),
      deliveryLabel: 'zum Datenabruf bereitgestellt',
      dateBasisLabel: 'nachgewiesener Bereitstellungstag',
      legalRemedyHint: 'Jahresfrist-Kontrollvorschlag (§ 356 Abs. 2 AO)',
    });
  });

  it('zeigt unbekannte Werte roh und lässt fehlende Angaben weg', () => {
    const vm = toNoticeRowVm(
      notice({
        kind: 'NEU_ART',
        deliveryMethod: 'X',
        dateBasis: 'Y',
        legalRemedyInstructionStatus: 'UNKLAR',
      }),
      TODAY,
    );
    expect(vm).toMatchObject({
      kindLabel: 'NEU_ART',
      fileNumberSuffix: null,
      documentHref: null,
      filing: null,
      deliveryLabel: 'X',
      dateBasisLabel: 'Y',
      legalRemedyHint: 'Rechtsbehelfsbelehrung unklar – manuell prüfen',
    });
    expect(
      toNoticeRowVm(notice({ legalRemedyInstructionStatus: 'WIRKSAM' }), TODAY).legalRemedyHint,
    ).toBeNull();
  });

  it('zeigt die Datenabruf-Nachweise nur, soweit sie erfasst sind (§ 122a AO)', () => {
    expect(toNoticeRowVm(notice(), TODAY).retrieval).toEqual({
      issuedAt: null,
      notificationDate: null,
      notificationStatus: null,
      consentStatus: null,
      eligibility2027Status: null,
      postalRequest: null,
      legacyFallback: false,
      decisiveRetrieval: null,
    });
    const vm = toNoticeRowVm(
      notice({
        retrievalIssuedAt: inDays(-30),
        retrievalNotificationDate: inDays(-29),
        retrievalNotificationStatus: 'FAILED',
        retrievalConsentStatus: 'CONFIRMED',
        retrievalEligibility2027Status: 'UNKNOWN',
        retrievalPostalRequestStatus: 'EFFECTIVE',
        retrievalPostalRequestReceivedAt: inDays(-100),
        retrievalNotificationLegacyFallback: true,
        retrievalNotificationDisputedOrLate: true,
        retrievedAt: inDays(-20),
      }),
      TODAY,
    );
    expect(vm.retrieval).toEqual({
      issuedAt: fmtDateShort(inDays(-30)),
      notificationDate: fmtDateShort(inDays(-29)),
      notificationStatus: 'FAILED',
      consentStatus: 'CONFIRMED',
      eligibility2027Status: 'UNKNOWN',
      postalRequest: {
        status: 'EFFECTIVE',
        receivedSuffix: ` (Zugang ${fmtDateShort(inDays(-100))})`,
      },
      legacyFallback: true,
      decisiveRetrieval: fmtDateShort(inDays(-20)),
    });
    // Ohne bestrittene/verspätete Benachrichtigung bleibt der Abruftag ungenannt.
    expect(
      toNoticeRowVm(notice({ retrievedAt: inDays(-20) }), TODAY).retrieval.decisiveRetrieval,
    ).toBeNull();
  });

  it.each([
    [null, decimal('100'), { kind: 'none' }],
    [decimal('abc'), decimal('100'), { kind: 'none' }],
    [decimal('150.5'), decimal('100'), { kind: 'higher', amount: fmtEUR(50.5) }],
    [decimal('100'), decimal('250'), { kind: 'lower', amount: fmtEUR(-150) }],
    [decimal('100'), decimal('100.00'), { kind: 'equal' }],
  ])('Abweichung %s gegen %s', (assessed, expected, delta) => {
    expect(amountDelta(assessed, expected)).toEqual(delta);
  });
});
