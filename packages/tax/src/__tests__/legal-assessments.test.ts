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

// Golden-Fälle mit gesetzlich fixierten Erwartungswerten. Der Feiertagskontext
// NRW ist bestätigt; keiner der Termine fällt auf einen NRW-Landesfeiertag, die
// Ergebnisse entsprechen damit dem bundeseinheitlichen Kalender.
describe('TAX-NOTICE-APPEAL-001 — Golden-Fälle §§ 122, 355, 356 AO und § 47 FGO', () => {
  function appeal(
    overrides: Partial<Parameters<typeof assessAppealDeadline>[0]> &
      Pick<Parameters<typeof assessAppealDeadline>[0], 'deliveryMethod'>,
  ) {
    return assessAppealDeadline({
      legalRemedyInstruction: 'VALID',
      notificationHolidayContext: confirmedContext(),
      deadlineHolidayContext: confirmedContext(),
      ...overrides,
    });
  }

  it.each([
    // Bescheid 01.02.2027 (Mo) → Fiktion 05.02.2027 (Fr) → +1 Monat 05.03.2027 (Fr).
    // Der frühere „+33 Tage"-Code hätte 06.03.2027 gezeigt — einen Tag zu spät.
    [
      'Regelfall: +4 Tage Fiktion, dann kalendarischer Monat',
      '2027-02-01',
      '2027-02-05',
      '2027-03-05',
    ],
    // Bescheid 12.01.2026 (Mo): +4 = 16.01.2026 (Fr) → +1 Monat 16.02.2026 (Mo).
    // Mit alter 3-Tage-Fiktion wäre die Bekanntgabe der 15.01. (Do) gewesen.
    ['4-Tage-Fiktion ab 2025, nicht 3', '2026-01-12', '2026-01-16', '2026-02-16'],
    // Bescheid 01.07.2026 (Mi): +4 = 05.07.2026 (So) → Bekanntgabe 06.07.2026 (Mo)
    // → +1 Monat 06.08.2026 (Do).
    [
      'Fiktionstag Sonntag → nächster Werktag (§ 108 Abs. 3 AO)',
      '2026-07-01',
      '2026-07-06',
      '2026-08-06',
    ],
    // Bescheid 27.01.2028 (Do): +4 = 31.01.2028 (Mo). 31.02. existiert nicht →
    // letzter Februartag 2028 (Schaltjahr) = 29.02.2028 (Di).
    [
      'Monatsende-Überlauf im Schaltjahr (§ 188 Abs. 3 BGB)',
      '2028-01-27',
      '2028-01-31',
      '2028-02-29',
    ],
    // Bescheid 21.11.2026 (Sa): +4 = 25.11.2026 (Mi). +1 Monat: 25.12. (Fr) und
    // 26.12. (Sa) Feiertage, 27.12. So → Fristende Mo 28.12.2026.
    ['Fristende über die Weihnachts-Feiertagskette', '2026-11-21', '2026-11-25', '2026-12-28'],
    // Art. 97 § 1 Abs. 15 EGAO: Aufgabe 10.12.2024 (Di) → +3 = 13.12.2024 (Fr)
    // → Fristende 13.01.2025 (Mo). Mit 4 Tagen wäre es der 16.01.2025 gewesen.
    [
      'Aufgabe bis 31.12.2024: Drei-Tages-Fiktion (§ 122 Abs. 2 AO a.F.)',
      '2024-12-10',
      '2024-12-13',
      '2025-01-13',
    ],
  ])('Inlandspost — %s', (_case, dispatch, notification, deadline) => {
    const result = appeal({ deliveryMethod: 'DOMESTIC_POST', dispatchDate: utc(dispatch) });

    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe(notification);
    expect(ymd(result.deadline)).toBe(deadline);
  });

  // § 122 Abs. 2 AO: Die Fiktion gilt nicht bei späterem Zugang; ein früherer
  // Zugang verkürzt sie nicht (Mindestschutz).
  it('ein festgestellter späterer Zugang ersetzt den Fiktionstag, ein früherer nicht', () => {
    const later = appeal({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2027-02-01'),
      access: { kind: 'ACTUAL_ACCESS_DETERMINED', date: utc('2027-02-09') },
    });
    expect(later.status).toBe('CALCULATED');
    expect(ymd(later.notificationDate)).toBe('2027-02-09');
    expect(ymd(later.deadline)).toBe('2027-03-09');

    const earlier = appeal({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2027-02-01'),
      access: { kind: 'ACTUAL_ACCESS_DETERMINED', date: utc('2027-02-03') },
    });
    expect(earlier.status).toBe('CALCULATED');
    expect(ymd(earlier.notificationDate)).toBe('2027-02-05');
    expect(ymd(earlier.deadline)).toBe('2027-03-05');
  });

  it('verschiebt einen festgestellten Zugang am Samstag nicht', () => {
    // Fiktion 05.07.2026 (So) → 06.07. Tatsächlich erst Sa 11.07.2026 zugegangen
    // (Faktum, keine Verschiebung) → Fristende 11.08.2026 (Di).
    const result = appeal({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2026-07-01'),
      access: { kind: 'ACTUAL_ACCESS_DETERMINED', date: utc('2026-07-11') },
    });

    expect(ymd(result.notificationDate)).toBe('2026-07-11');
    expect(ymd(result.deadline)).toBe('2026-08-11');
  });

  it('Auslandspost: ein Monat Fiktion plus ein Monat Frist; späterer Zugang geht vor', () => {
    const regular = appeal({ deliveryMethod: 'POST_ABROAD', dispatchDate: utc('2026-01-10') });
    expect(regular.status).toBe('CALCULATED');
    expect(ymd(regular.notificationDate)).toBe('2026-02-10');
    expect(ymd(regular.deadline)).toBe('2026-03-10');

    const laterAccess = appeal({
      deliveryMethod: 'POST_ABROAD',
      dispatchDate: utc('2026-01-10'),
      access: { kind: 'ACTUAL_ACCESS_DETERMINED', date: utc('2026-03-01') },
    });
    expect(ymd(laterAccess.notificationDate)).toBe('2026-03-01');
    expect(ymd(laterAccess.deadline)).toBe('2026-04-01');
  });

  it('festgestellter Bekanntgabetag: keine Fiktion; fehlende Belehrung → Jahresfrist', () => {
    const determined = (date: string, legalRemedyInstruction: 'VALID' | 'INVALID_OR_MISSING') =>
      appeal({
        deliveryMethod: 'DETERMINED_NOTIFICATION',
        determinedNotificationDate: utc(date),
        legalRemedyInstruction,
      });

    expect(ymd(determined('2026-07-07', 'VALID').deadline)).toBe('2026-08-07');
    // § 356 Abs. 2 AO (Einspruch) bzw. § 55 Abs. 2 FGO (Klage): Jahresfrist.
    expect(ymd(determined('2026-07-07', 'INVALID_OR_MISSING').deadline)).toBe('2027-07-07');
    // 29.02.2028 + ein Jahr → 28.02.2029 (Mi), keine Verschiebung.
    expect(ymd(determined('2028-02-29', 'INVALID_OR_MISSING').deadline)).toBe('2029-02-28');
  });

  // Die Klagefrist (§ 47 Abs. 1 FGO) läuft ab dem bereits festgestellten
  // Bekanntgabetag der Einspruchsentscheidung; notice-transition.ts rechnet sie
  // deshalb mit DETERMINED_NOTIFICATION.
  it('Klagefrist: keine erneute Bekanntgabefiktion auf die Einspruchsentscheidung', () => {
    const klage = appeal({
      deliveryMethod: 'DETERMINED_NOTIFICATION',
      determinedNotificationDate: utc('2026-07-07'),
    });
    // Mit Fiktion wäre die Frist knapp eine Woche zu spät: 11.07. (Sa) → 13.07.
    // → 13.08.2026.
    const withFiction = appeal({
      deliveryMethod: 'DOMESTIC_POST',
      dispatchDate: utc('2026-07-07'),
    });

    expect(ymd(klage.deadline)).toBe('2026-08-07');
    expect(ymd(withFiction.deadline)).toBe('2026-08-13');
  });

  it('Klagefrist: Monatsende-Überlauf mit Werktagsverschiebung und Tagesnormalisierung', () => {
    // 31.01.2026 (Sa) → 31.02. existiert nicht → 28.02.2026 (Sa) → Mo 02.03.2026.
    const overflow = appeal({
      deliveryMethod: 'DETERMINED_NOTIFICATION',
      determinedNotificationDate: utc('2026-01-31'),
    });
    expect(ymd(overflow.deadline)).toBe('2026-03-02');

    // 14:30 UTC am 07.07.2026 → derselbe Fristbeginn wie Mitternacht.
    const afternoon = appeal({
      deliveryMethod: 'DETERMINED_NOTIFICATION',
      determinedNotificationDate: new Date('2026-07-07T14:30:00Z'),
    });
    expect(ymd(afternoon.deadline)).toBe('2026-08-07');
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

describe('TAX-NOTICE-DATARETRIEVAL-001 — Golden-Fälle § 122a AO am Stichtag 01.01.2026', () => {
  const base = {
    provisionEvidence: 'PROFESSIONALLY_DETERMINED' as const,
    legalRemedyInstruction: 'VALID' as const,
    notificationHolidayContext: confirmedContext(),
    deadlineHolidayContext: confirmedContext(),
  };

  it('bleibt ohne Erlassdatum fail-closed', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: null,
      provisionDate: utc('2026-01-12'),
      notificationStatus: 'SAME_DAY_CONFIRMED',
    });

    expect(result.regime).toBe('UNKNOWN');
    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.deadline).toBeNull();
    expect(result.manualReviewReasons).toContain('ISSUED_AT_UNKNOWN');
  });

  it('bleibt im Altfall ohne Versandtag der Benachrichtigung fail-closed', () => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2025-01-09'),
      provisionDate: utc('2025-01-10'),
      notificationStatus: 'LATE',
    });

    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.deadline).toBeNull();
    expect(result.manualReviewReasons).toContain('LEGACY_NOTIFICATION_DATE_UNKNOWN');
  });

  it.each([
    // Altfall: Versand der Benachrichtigung 10.12.2024 + 3 = 13.12.2024 (Fr).
    [
      'Benachrichtigung 2024 bei Bereitstellung 2024: drei Tage',
      '2024-12-08',
      '2024-12-09',
      '2024-12-10',
      '2024-12-13',
      '2025-01-13',
    ],
    // Art. 97 § 1 Abs. 15 EGAO: Bereitstellung noch am 31.12.2024, Versand am
    // 01.01.2025 → noch drei Tage: 04.01.2025 (Sa) → Mo 06.01.2025.
    [
      '3→4-Tage-Übergang nach der Bereitstellung',
      '2024-12-30',
      '2024-12-31',
      '2025-01-01',
      '2025-01-06',
      '2025-02-06',
    ],
    // Erlass 31.12.2025 → Altrecht trotz Bereitstellung 2026; Bereitstellung 2026
    // → vier Tage ab Versand: 07.01.2026 (Mi); Fristende 07.02. (Sa) → 09.02.2026.
    [
      'Erlass 2025, Bereitstellung 2026: Altrecht mit vier Tagen',
      '2025-12-31',
      '2026-01-02',
      '2026-01-03',
      '2026-01-07',
      '2026-02-09',
    ],
  ])('Altfall — %s', (_case, issued, provision, notificationSent, notification, deadline) => {
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc(issued),
      provisionDate: utc(provision),
      legacyNotificationDate: utc(notificationSent),
      notificationStatus: 'LATE',
    });

    expect(result.regime).toBe('LEGACY_UNTIL_2025');
    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe(notification);
    expect(ymd(result.deadline)).toBe(deadline);
  });

  it('verwendet im Altfall bei bestrittener oder verspäteter Benachrichtigung den Abruf', () => {
    const legacy = {
      ...base,
      issuedAt: utc('2025-01-09'),
      provisionDate: utc('2025-01-10'),
      legacyNotificationDate: utc('2025-01-13'),
      legacyNotificationDisputedOrLate: true,
      notificationStatus: 'LATE' as const,
    };

    const retrieved = assessDataRetrievalDeadline({
      ...legacy,
      legacyRetrievedAt: utc('2025-01-20'),
    });
    expect(retrieved.status).toBe('CALCULATED');
    expect(ymd(retrieved.notificationDate)).toBe('2025-01-20');
    expect(ymd(retrieved.deadline)).toBe('2025-02-20');

    // Ohne nachgewiesenen Benachrichtigungszugang und ohne Abruf keine Bekanntgabe.
    const notRetrieved = assessDataRetrievalDeadline(legacy);
    expect(notRetrieved.status).toBe('MANUAL_REVIEW');
    expect(notRetrieved.deadline).toBeNull();
    expect(notRetrieved.manualReviewReasons).toContain('LEGACY_NOTIFICATION_ACCESS_DISPUTED');
  });

  it('lässt altrechtliche Zusatzangaben die Neufassung nicht verändern', () => {
    // Erlass 11.01.2026, Bereitstellung 12.01.2026 (Mo) + 4 = 16.01.2026 (Fr)
    // → Fristende 16.02.2026 (Mo).
    const result = assessDataRetrievalDeadline({
      ...base,
      issuedAt: utc('2026-01-11'),
      provisionDate: utc('2026-01-12'),
      consent2026: 'ACTIVE_DOCUMENTED',
      notificationStatus: 'SAME_DAY_CONFIRMED',
      legacyNotificationDate: utc('2026-01-20'),
      legacyNotificationDisputedOrLate: true,
      legacyRetrievedAt: utc('2026-01-21'),
    });

    expect(result.regime).toBe('CONSENT_2026');
    expect(result.status).toBe('CALCULATED');
    expect(ymd(result.notificationDate)).toBe('2026-01-16');
    expect(ymd(result.deadline)).toBe('2026-02-16');
  });
});
