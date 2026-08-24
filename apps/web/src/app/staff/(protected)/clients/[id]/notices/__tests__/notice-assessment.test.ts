// Fachkatalog: TAX-DEADLINE-WORKDAY-001
// Fachkatalog: TAX-NOTICE-APPEAL-001
// Fachkatalog: TAX-NOTICE-DATARETRIEVAL-001

import { describe, expect, it } from 'vitest';
import type { HolidayLocationContext } from '@taxtronik/tax';
import {
  assessNoticeEvidence,
  determinedAccessDateIsConsistent,
  type NoticeAssessmentInput,
} from '../notice-assessment';

function utc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function ymd(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

function context(
  region: HolidayLocationContext['region'] = 'DE-NW',
  overrides: Partial<HolidayLocationContext> = {},
): HolidayLocationContext {
  return {
    countryCode: 'DE',
    region,
    locality: 'Musterstadt',
    calendarStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION',
    localHolidays: [],
    ...overrides,
  };
}

function base(overrides: Partial<NoticeAssessmentInput> = {}): NoticeAssessmentInput {
  return {
    deliveryMethod: 'POST',
    noticeDate: utc('2026-02-04'),
    dateBasis: 'DISPATCH_DATE',
    deliveryEvidenceStatus: 'SUBSTANTIATED',
    legalRemedyInstructionStatus: 'WIRKSAM',
    accessStatus: 'UNCONTESTED',
    receivedAt: null,
    accessEvidenceStatus: null,
    recipientHolidayContext: context(),
    authorityHolidayContext: context(),
    retrieval: {
      issuedAt: null,
      notificationDate: null,
      notificationDisputedOrLate: false,
      retrievedAt: null,
      consentStatus: 'NOT_APPLICABLE',
      eligibility2027Status: 'NOT_APPLICABLE',
      postalRequestStatus: 'NOT_APPLICABLE',
      postalRequestReceivedAt: null,
      notificationStatus: 'NOT_RECORDED',
    },
    ...overrides,
  };
}

describe('beweisorientierte Bescheidbewertung', () => {
  it('akzeptiert beim fachlich festgestellten Bekanntgabetag nur identische Datumsfelder', () => {
    expect(
      determinedAccessDateIsConsistent({
        dateBasis: 'ACTUAL_ACCESS_DETERMINED',
        noticeDate: utc('2026-02-09'),
        receivedAt: utc('2026-02-09'),
      }),
    ).toBe(true);
    expect(
      determinedAccessDateIsConsistent({
        dateBasis: 'ACTUAL_ACCESS_DETERMINED',
        noticeDate: utc('2026-02-04'),
        receivedAt: utc('2026-02-09'),
      }),
    ).toBe(false);
    expect(
      determinedAccessDateIsConsistent({
        dateBasis: 'ACTUAL_ACCESS_DETERMINED',
        noticeDate: utc('2026-02-09'),
        receivedAt: null,
      }),
    ).toBe(false);
  });

  it('weist das Bescheiddatum bei unbekanntem Versandtag nur als Risikoszenario aus', () => {
    const result = assessNoticeEvidence(
      base({
        dateBasis: 'DOCUMENT_DATE_RISK_ONLY',
        deliveryEvidenceStatus: 'CLAIMED',
      }),
    );

    expect(result.calculationStatus).toBe('RISK_ONLY');
    expect(result.notificationDate).toBeNull();
    expect(result.appealDeadline).toBeNull();
    expect(ymd(result.internalRiskDeadline)).toBe('2026-03-09');
  });

  it('wendet örtliche Feiertage für Fiktionstag und Fristende getrennt an', () => {
    const result = assessNoticeEvidence(
      base({
        recipientHolidayContext: context('DE-NW', {
          localHolidays: [utc('2026-02-09')],
        }),
        authorityHolidayContext: context('DE-NW', {
          localHolidays: [utc('2026-03-10')],
        }),
      }),
    );

    expect(result.calculationStatus).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2026-02-10');
    expect(ymd(result.appealDeadline)).toBe('2026-03-11');
  });

  it('führt bei behauptet späterem Zugang beide Szenarien ohne Rechtsfreigabe', () => {
    const result = assessNoticeEvidence(
      base({
        noticeDate: utc('2027-02-01'),
        accessStatus: 'LATER_RECEIPT_CLAIMED',
        receivedAt: utc('2027-02-09'),
        accessEvidenceStatus: 'SUBSTANTIATED',
      }),
    );

    expect(result.calculationStatus).toBe('MANUAL_REVIEW');
    expect(result.appealDeadline).toBeNull();
    expect(ymd(result.internalRiskDeadline)).toBe('2027-03-05');
    expect(ymd(result.alternativeClaimedAccessDeadline)).toBe('2027-03-09');
  });

  it('verkürzt die Vier-Tage-Fiktion nicht durch einen früheren Eingang', () => {
    const result = assessNoticeEvidence(
      base({
        accessStatus: 'EARLIER_RECEIPT_RECORDED',
        receivedAt: utc('2026-02-06'),
        accessEvidenceStatus: 'SUBSTANTIATED',
      }),
    );

    expect(result.calculationStatus).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2026-02-09');
    expect(ymd(result.appealDeadline)).toBe('2026-03-09');
  });

  it('übernimmt einen fachlich als später markierten, tatsächlich früheren Zugang nicht', () => {
    const result = assessNoticeEvidence(
      base({
        accessStatus: 'LATER_RECEIPT_DETERMINED',
        receivedAt: utc('2026-02-06'),
        accessEvidenceStatus: 'PROFESSIONALLY_DETERMINED',
      }),
    );

    expect(result.calculationStatus).toBe('MANUAL_REVIEW');
    expect(result.appealDeadline).toBeNull();
    expect(result.manualReviewReasons).toContain('DETERMINED_LATER_ACCESS_NOT_AFTER_FICTION');
  });

  it('behält 2026 bei Benachrichtigungsfehler die Fiktion und eröffnet § 110', () => {
    const result = assessNoticeEvidence(
      base({
        deliveryMethod: 'DATA_RETRIEVAL',
        noticeDate: utc('2026-03-10'),
        dateBasis: 'PROVISION_DATE',
        deliveryEvidenceStatus: 'PROFESSIONALLY_DETERMINED',
        retrieval: {
          issuedAt: utc('2026-03-09'),
          notificationDate: null,
          notificationDisputedOrLate: false,
          retrievedAt: null,
          consentStatus: 'CONFIRMED',
          eligibility2027Status: 'NOT_APPLICABLE',
          postalRequestStatus: 'NOT_APPLICABLE',
          postalRequestReceivedAt: null,
          notificationStatus: 'FAILED',
        },
      }),
    );

    expect(result.calculationStatus).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2026-03-16');
    expect(ymd(result.appealDeadline)).toBe('2026-04-16');
    expect(result.manualReviewRequired).toBe(true);
    expect(result.reinstatementReviewRequired).toBe(true);
  });

  it('wertet ab 2027 den Zugang des Postantrags relativ zur Bereitstellung aus', () => {
    const retrieval = {
      issuedAt: utc('2027-01-31'),
      notificationDate: utc('2027-02-01'),
      notificationDisputedOrLate: false,
      retrievedAt: null,
      consentStatus: 'NOT_APPLICABLE' as const,
      eligibility2027Status: 'CONFIRMED' as const,
      postalRequestStatus: 'EFFECTIVE' as const,
      notificationStatus: 'SENT' as const,
    };
    const common = base({
      deliveryMethod: 'DATA_RETRIEVAL',
      noticeDate: utc('2027-02-01'),
      dateBasis: 'PROVISION_DATE',
      deliveryEvidenceStatus: 'PROFESSIONALLY_DETERMINED',
    });

    const timely = assessNoticeEvidence({
      ...common,
      retrieval: { ...retrieval, postalRequestReceivedAt: utc('2027-01-31') },
    });
    expect(timely.calculationStatus).toBe('MANUAL_REVIEW');
    expect(timely.appealDeadline).toBeNull();

    const later = assessNoticeEvidence({
      ...common,
      retrieval: { ...retrieval, postalRequestReceivedAt: utc('2027-02-02') },
    });
    expect(later.calculationStatus).toBe('CALCULATED');
    expect(ymd(later.appealDeadline)).toBe('2027-03-05');
  });
});
