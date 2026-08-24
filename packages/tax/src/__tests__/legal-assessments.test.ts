// Fachkatalog: TAX-DEADLINE-WORKDAY-001
// Fachkatalog: TAX-NOTICE-APPEAL-001
// Fachkatalog: TAX-NOTICE-DATARETRIEVAL-001

import { describe, expect, it } from 'vitest';
import {
  assessAppealDeadline,
  assessDataRetrievalDeadline,
  assessWorkdayShift,
  type GermanRegion,
  type HolidayLocationContext,
  type WorkdayApplicationType,
} from '../index';

function utc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function ymd(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

function confirmedContext(
  region: GermanRegion = 'DE-NW',
  overrides: Partial<HolidayLocationContext> = {},
): HolidayLocationContext {
  return {
    countryCode: 'DE',
    region,
    locality: 'Musterstadt',
    calendarStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION',
    ...(region === 'DE-BY' ? { bavariaAssumptionApplies: false } : {}),
    ...overrides,
  };
}

describe('TAX-DEADLINE-WORKDAY-001 — beweisorientierte §-108-Vorprüfung', () => {
  it('berechnet nur den bestätigten Standardfall abschließend', () => {
    const result = assessWorkdayShift({
      date: utc('2025-06-19'), // Fronleichnam in Nordrhein-Westfalen
      applicationType: 'STANDARD_DEADLINE_END',
      holidayContext: confirmedContext('DE-NW'),
    });

    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.date)).toBe('2025-06-20');
    expect(result.shifted).toBe(true);
    expect(result.manualReviewReasons).toEqual([]);
  });

  it.each<WorkdayApplicationType>([
    'AUTHORITY_PERFORMANCE_PERIOD',
    'AUTHORITY_FIXED_DATE',
    'HOURLY_DEADLINE',
    'UNCLEAR',
  ])('%s wird nicht schematisch wie ein Standard-Fristende verschoben', (applicationType) => {
    const result = assessWorkdayShift({
      date: utc('2026-08-15'), // Samstag
      applicationType,
      holidayContext: confirmedContext(),
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.date).toBeNull();
    expect(ymd(result.controlDate)).toBe('2026-08-15');
    expect(result.shifted).toBe(false);
  });

  it('gibt bei unbekanntem Feiertagsort nur einen Kontrolltermin aus', () => {
    const result = assessWorkdayShift({
      date: utc('2025-10-31'),
      applicationType: 'STANDARD_DEADLINE_END',
      holidayContext: {
        countryCode: 'DE',
        region: null,
        calendarStatus: 'UNKNOWN',
      },
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.date).toBeNull();
    expect(result.manualReviewReasons).toContain('HOLIDAY_REGION_UNKNOWN');
    expect(result.manualReviewReasons).toContain('HOLIDAY_CALENDAR_UNKNOWN');
  });

  it('gibt ohne dokumentierten Ort trotz bestätigtem Landeskalender kein Rechtsdatum aus', () => {
    const result = assessWorkdayShift({
      date: utc('2026-05-01'),
      applicationType: 'STANDARD_DEADLINE_END',
      holidayContext: confirmedContext('DE-NW', { locality: null }),
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.date).toBeNull();
    expect(ymd(result.controlDate)).toBe('2026-05-04');
    expect(result.manualReviewReasons).toContain('HOLIDAY_LOCALITY_UNKNOWN');
  });

  it.each([
    ['STATE_LEVEL_ONLY', 'LOCAL_HOLIDAY_CALENDAR_INCOMPLETE'],
    ['HISTORICAL_UNVERIFIED', 'HISTORICAL_HOLIDAY_CALENDAR_UNVERIFIED'],
  ] as const)(
    '%s bleibt trotz berechenbarem Kontrollwert ein Prüffall',
    (calendarStatus, reason) => {
      const result = assessWorkdayShift({
        date: utc('2026-05-01'),
        applicationType: 'STANDARD_DEADLINE_END',
        holidayContext: confirmedContext('DE-NW', { calendarStatus }),
      });

      expect(result.status).toBe('MANUAL_REVIEW');
      expect(result.date).toBeNull();
      expect(ymd(result.controlDate)).toBe('2026-05-04');
      expect(result.manualReviewReasons).toContain(reason);
    },
  );

  it('berücksichtigt bestätigte örtliche Feiertage in einer Kettenlage', () => {
    const result = assessWorkdayShift({
      date: utc('2026-08-15'), // Samstag; Montag ist hier als örtlicher Feiertag belegt
      applicationType: 'STANDARD_DEADLINE_END',
      holidayContext: confirmedContext('DE-NW', { localHolidays: [utc('2026-08-17')] }),
    });

    expect(ymd(result.date)).toBe('2026-08-18');
  });

  it('erzwingt für Bayern eine ausdrückliche Gemeindeentscheidung', () => {
    const result = assessWorkdayShift({
      date: utc('2025-08-15'),
      applicationType: 'STANDARD_DEADLINE_END',
      holidayContext: confirmedContext('DE-BY', { bavariaAssumptionApplies: null }),
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.date).toBeNull();
    expect(result.manualReviewReasons).toContain('BAVARIA_ASSUMPTION_UNRESOLVED');
    // Kontrolltermin ist bewusst die frühere, risikoorientierte Variante.
    expect(ymd(result.controlDate)).toBe('2025-08-15');
  });

  it('behauptet für einen ausländischen Feiertagskalender kein Ergebnis', () => {
    const result = assessWorkdayShift({
      date: utc('2026-07-04'),
      applicationType: 'STANDARD_DEADLINE_END',
      holidayContext: {
        countryCode: 'US',
        region: null,
        calendarStatus: 'FOREIGN_UNSUPPORTED',
      },
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.date).toBeNull();
    expect(ymd(result.controlDate)).toBe('2026-07-04');
    expect(result.manualReviewReasons).toContain('FOREIGN_HOLIDAY_CALENDAR_UNSUPPORTED');
  });
});

describe('TAX-NOTICE-APPEAL-001 — Bekanntgabe und Einspruchsfrist', () => {
  it('verwendet für Fiktionstag und Fristende getrennte Feiertagsregionen', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2025-10-27'),
      legalRemedyInstruction: 'VALID',
      // 31.10. ist in Niedersachsen Feiertag: Fiktion wird auf 03.11. verschoben.
      notificationHolidayContext: confirmedContext('DE-NI'),
      // Für das Einspruchsfristende ist der Behördensitz in NRW maßgeblich.
      deadlineHolidayContext: confirmedContext('DE-NW'),
    });

    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2025-11-03');
    expect(ymd(result.deadline)).toBe('2025-12-03');
  });

  it('berechnet bei unbekanntem Versanddatum aus dem Bescheiddatum nur einen Risikotermin', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: null,
      riskReferenceDate: utc('2026-04-01'),
      legalRemedyInstruction: 'VALID',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: confirmedContext(),
    });

    expect(result.status).toBe('RISK_ONLY');
    expect(result.notificationDate).toBeNull();
    expect(result.deadline).toBeNull();
    expect(ymd(result.riskDeadline)).toBe('2026-05-07');
    expect(result.manualReviewReasons).toContain('DISPATCH_DATE_UNKNOWN');
    expect(result.manualReviewReasons).toContain('RISK_DATE_ONLY');
  });

  it('nutzt bei unbekanntem Versanddatum einen unabhängig festgestellten Zugang', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: null,
      access: { kind: 'ACTUAL_ACCESS_DETERMINED', date: utc('2026-04-05') },
      legalRemedyInstruction: 'VALID',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: confirmedContext(),
    });

    expect(result.status).toBe('CALCULATED');
    // Ein tatsächlicher Zugang am Sonntag wird nicht selbst werktagsverschoben.
    expect(ymd(result.notificationDate)).toBe('2026-04-05');
    expect(ymd(result.deadline)).toBe('2026-05-05');
  });

  it('übernimmt einen lediglich behaupteten späteren Zugang nicht automatisch', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2027-02-01'),
      access: { kind: 'LATER_ACCESS_CLAIMED', date: utc('2027-02-09') },
      legalRemedyInstruction: 'VALID',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: confirmedContext(),
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.notificationDate).toBeNull();
    expect(result.deadline).toBeNull();
    expect(ymd(result.controlDeadline)).toBe('2027-03-05');
    expect(ymd(result.claimedAccessControlDeadline)).toBe('2027-03-09');
    expect(result.manualReviewReasons).toContain('LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW');
  });

  it('weist einen als später bezeichneten Zugang vor dem Fiktionstag als widersprüchlich aus', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2027-02-01'),
      access: { kind: 'LATER_ACCESS_CLAIMED', date: utc('2027-02-04') },
      legalRemedyInstruction: 'VALID',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: confirmedContext(),
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.claimedAccessControlDeadline).toBeNull();
    expect(result.manualReviewReasons).toContain('CLAIMED_LATER_ACCESS_NOT_AFTER_FICTION');
  });

  it('verkürzt die Fiktion nicht durch einen früheren tatsächlichen Eingang', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2026-02-04'),
      access: { kind: 'EARLIER_ACCESS_RECORDED', date: utc('2026-02-06') },
      legalRemedyInstruction: 'VALID',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: confirmedContext(),
    });

    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2026-02-09');
    expect(ymd(result.deadline)).toBe('2026-03-09');
  });

  it('setzt bei unklarer Rechtsbehelfsbelehrung keine automatische Frist fest', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DETERMINED_NOTIFICATION',
      determinedNotificationDate: utc('2026-07-07'),
      legalRemedyInstruction: 'UNCLEAR',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: confirmedContext(),
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(ymd(result.notificationDate)).toBe('2026-07-07');
    expect(result.deadline).toBeNull();
    expect(ymd(result.controlDeadline)).toBe('2026-08-07');
  });

  it('bewahrt den bekannten Bekanntgabetag, wenn nur der Feiertagsort des Fristendes fehlt', () => {
    const result = assessAppealDeadline({
      deliveryMethod: 'DETERMINED_NOTIFICATION',
      determinedNotificationDate: utc('2026-07-07'),
      legalRemedyInstruction: 'VALID',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: {
        countryCode: 'DE',
        region: null,
        calendarStatus: 'UNKNOWN',
      },
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(ymd(result.notificationDate)).toBe('2026-07-07');
    expect(result.deadline).toBeNull();
    expect(result.manualReviewReasons).toContain('DEADLINE_WORKDAY_REVIEW_REQUIRED');
  });
});

describe('TAX-NOTICE-DATARETRIEVAL-001 — § 122a AO', () => {
  const base = {
    provisionEvidence: 'PROFESSIONALLY_DETERMINED' as const,
    legalRemedyInstruction: 'VALID' as const,
    notificationHolidayContext: confirmedContext(),
    deadlineHolidayContext: confirmedContext(),
  };

  it('kennzeichnet einen rein technischen Bereitstellungsnachweis als fachlich ungeprüft', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      provisionEvidence: 'TECHNICALLY_EVIDENCED',
      issuedAt: utc('2026-03-09'),
      provisionDate: utc('2026-03-10'),
      consent2026: 'ACTIVE_DOCUMENTED',
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });

    expect(result.status).toBe('CALCULATED_WITH_REVIEW');
    expect(ymd(result.deadline)).toBe('2026-04-16');
    expect(result.manualReviewReasons).toContain('PROVISION_PROFESSIONAL_APPROVAL_PENDING');
  });

  it('verlangt 2026 eine dokumentierte aktive Einwilligung', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2026-03-09'),
      provisionDate: utc('2026-03-10'),
      consent2026: 'UNKNOWN',
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });

    expect(result.regime).toBe('CONSENT_2026');
    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.deadline).toBeNull();
    expect(ymd(result.controlDeadline)).toBe('2026-04-16');
    expect(result.manualReviewReasons).toContain('ACTIVE_CONSENT_2026_NOT_DOCUMENTED');
  });

  it('berechnet den belegten 2026-Standardfall ab Bereitstellung plus vier Tagen', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2026-03-09'),
      provisionDate: utc('2026-03-10'),
      consent2026: 'ACTIVE_DOCUMENTED',
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });

    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2026-03-16');
    expect(ymd(result.deadline)).toBe('2026-04-16');
  });

  it('lässt einen Benachrichtigungsfehler den Fiktionstag unverändert und eröffnet §-110-Prüfung', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2026-03-09'),
      provisionDate: utc('2026-03-10'),
      consent2026: 'ACTIVE_DOCUMENTED',
      notificationStatus: 'FAILED',
    });

    expect(result.status).toBe('CALCULATED_WITH_REVIEW');
    expect(ymd(result.notificationDate)).toBe('2026-03-16');
    expect(ymd(result.deadline)).toBe('2026-04-16');
    expect(result.notificationDutyDeviation).toBe(true);
    expect(result.reinstatementReviewRequired).toBe(true);
    expect(result.manualReviewReasons).toContain(
      'NOTIFICATION_DUTY_DEVIATION_REQUIRES_SECTION_110_REVIEW',
    );
  });

  it('prüft ab 2027 Voraussetzungen und Postantrag getrennt', () => {
    const calculated = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2027-01-31'),
      provisionDate: utc('2027-02-01'),
      eligibility2027: 'CONFIRMED',
      postalRequestStatus: 'NO_EFFECTIVE_REQUEST',
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });
    expect(calculated.regime).toBe('DEFAULT_FROM_2027');
    expect(calculated.status).toBe('CALCULATED');
    expect(ymd(calculated.deadline)).toBe('2027-03-05');

    const withPostalRequest = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2027-01-31'),
      provisionDate: utc('2027-02-01'),
      eligibility2027: 'CONFIRMED',
      postalRequestStatus: 'EFFECTIVE_REQUEST',
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });
    expect(withPostalRequest.status).toBe('MANUAL_REVIEW');
    expect(withPostalRequest.deadline).toBeNull();
    expect(withPostalRequest.reinstatementReviewRequired).toBe(true);
    expect(withPostalRequest.manualReviewReasons).toContain(
      'POSTAL_REQUEST_EFFECT_REQUIRES_REVIEW',
    );

    const requestReceivedAfterProvision = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2027-01-31'),
      provisionDate: utc('2027-02-01'),
      eligibility2027: 'CONFIRMED',
      postalRequestStatus: 'EFFECTIVE_REQUEST',
      postalRequestReceivedAt: utc('2027-02-02'),
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });
    expect(requestReceivedAfterProvision.status).toBe('CALCULATED');
    expect(requestReceivedAfterProvision.reinstatementReviewRequired).toBe(false);
    expect(ymd(requestReceivedAfterProvision.deadline)).toBe('2027-03-05');
  });

  it('wählt das Regime nach Erlassdatum, nicht nach Bereitstellungsdatum', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2026-12-31'),
      provisionDate: utc('2027-01-02'),
      consent2026: 'UNKNOWN',
      eligibility2027: 'CONFIRMED',
      postalRequestStatus: 'NO_EFFECTIVE_REQUEST',
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });

    expect(result.regime).toBe('CONSENT_2026');
    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.manualReviewReasons).toContain('ACTIVE_CONSENT_2026_NOT_DOCUMENTED');
  });

  it('behält für Erlass bis 2025 die altrechtliche Benachrichtigungslogik', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2025-01-09'),
      provisionDate: utc('2025-01-10'),
      legacyNotificationDate: utc('2025-01-13'),
      notificationStatus: 'LATE',
    });

    expect(result.regime).toBe('LEGACY_UNTIL_2025');
    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2025-01-17');
    expect(ymd(result.deadline)).toBe('2025-02-17');
  });

  it('bestimmt die Drei-/Vier-Tage-Fassung im Altfall nach dem Bereitstellungstag', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2024-12-29'),
      provisionDate: utc('2024-12-30'),
      legacyNotificationDate: utc('2025-01-03'),
      notificationStatus: 'LATE',
    });

    expect(result.regime).toBe('LEGACY_UNTIL_2025');
    // 30.12.2024 bereitgestellt: weiterhin Drei-Tage-Fassung; maßgeblicher
    // Ausgangstag ist die bestätigte Benachrichtigung am 03.01.2025.
    // Drei Tage führen (ohne weitere Verschiebung) zum 06.01.; vier Tage
    // würden fälschlich den 07.01. ergeben.
    expect(ymd(result.notificationDate)).toBe('2025-01-06');
    expect(ymd(result.deadline)).toBe('2025-02-06');
  });

  it('blockiert den Altfall ohne Bereitstellungstag statt beim Cutover abzustürzen', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2024-12-29'),
      provisionDate: null,
      legacyNotificationDate: utc('2025-01-03'),
      notificationStatus: 'LATE',
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.notificationDate).toBeNull();
    expect(result.deadline).toBeNull();
    expect(result.manualReviewReasons).toContain('PROVISION_DATE_UNKNOWN');
  });

  it('erzeugt im Altrecht aus fehlgeschlagenem oder unklarem Versand keine Frist', () => {
    for (const notificationStatus of ['FAILED', 'UNKNOWN'] as const) {
      const result = assessDataRetrievalDeadline({
        ...base,
        issuedAt: utc('2025-01-09'),
        provisionDate: utc('2025-01-10'),
        legacyNotificationDate: utc('2025-01-13'),
        notificationStatus,
      });

      expect(result.status).toBe('MANUAL_REVIEW');
      expect(result.deadline).toBeNull();
      expect(result.manualReviewReasons).toContain('LEGACY_NOTIFICATION_OUTCOME_NOT_CONFIRMED');
    }
  });
});
