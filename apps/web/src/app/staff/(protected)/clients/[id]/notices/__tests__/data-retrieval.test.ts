// Fachkatalog: TAX-NOTICE-DATARETRIEVAL-001
import { describe, expect, it } from 'vitest';
import { validateDataRetrievalEvidence } from '../data-retrieval';

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const today = date('2026-08-23');

function validate(overrides: Partial<Parameters<typeof validateDataRetrievalEvidence>[0]> = {}) {
  return validateDataRetrievalEvidence({
    deliveryMethod: 'DATA_RETRIEVAL',
    provisionDate: date('2025-12-20'),
    issuedAt: date('2025-12-19'),
    notificationDate: date('2025-12-22'),
    notificationDisputedOrLate: false,
    retrievedAt: null,
    consentStatus: 'NOT_APPLICABLE',
    eligibility2027Status: 'NOT_APPLICABLE',
    postalRequestStatus: 'NOT_APPLICABLE',
    postalRequestReceivedAt: null,
    notificationStatus: 'SENT',
    today,
    ...overrides,
  });
}

describe('§ 122a AO: Eingabeevidenz am Stichtag 01.01.2026', () => {
  it('verlangt Erlassdatum und im alten Regime den Versandtag der Benachrichtigung', () => {
    expect(validate({ issuedAt: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Erlass'),
    });
    expect(validate({ notificationDate: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Benachrichtigung'),
    });
  });

  it('bildet den bestrittenen Altfall ohne Abruf als noch nicht bekanntgegeben ab', () => {
    expect(validate({ notificationDisputedOrLate: true })).toEqual({ ok: true });
    expect(validate({ notificationDisputedOrLate: true, retrievedAt: date('2025-12-29') })).toEqual(
      { ok: true },
    );
  });

  it('blockiert widersprüchliche altrechtliche Datumsfolgen', () => {
    expect(validate({ issuedAt: date('2025-12-21') })).toMatchObject({ ok: false });
    expect(validate({ notificationDate: date('2025-12-19') })).toMatchObject({ ok: false });
    expect(
      validate({
        notificationDisputedOrLate: true,
        retrievedAt: date('2025-12-19'),
      }),
    ).toMatchObject({ ok: false });
  });

  it('lässt im Altrecht nur bestätigten Versand oder den markierten Streitfall zu', () => {
    expect(validate({ notificationStatus: 'FAILED' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('bestätigter Versand'),
    });
    expect(validate({ notificationStatus: 'FAILED', notificationDisputedOrLate: true })).toEqual({
      ok: true,
    });
  });

  it('entscheidet den Cutover nach Erlassdatum statt Bereitstellung', () => {
    expect(
      validate({
        issuedAt: date('2025-12-31'),
        provisionDate: date('2026-01-02'),
        notificationDate: date('2026-01-03'),
      }),
    ).toMatchObject({ ok: true });
    expect(
      validate({
        issuedAt: date('2026-01-01'),
        provisionDate: date('2026-01-02'),
        notificationDate: null,
        notificationStatus: 'NOT_RECORDED',
        consentStatus: 'CONFIRMED',
      }),
    ).toEqual({ ok: true });
    expect(
      validate({
        issuedAt: date('2026-01-01'),
        provisionDate: date('2026-01-02'),
        notificationDate: date('2026-01-03'),
        notificationStatus: 'SENT',
        consentStatus: 'CONFIRMED',
      }),
    ).toEqual({ ok: true });
  });

  it('hält Benachrichtigung und Abruf im Neurecht als getrennte Kontrollangaben zulässig', () => {
    expect(
      validate({
        issuedAt: date('2026-03-09'),
        provisionDate: date('2026-03-10'),
        notificationDate: date('2026-03-10'),
        notificationStatus: 'SENT',
        retrievedAt: date('2026-03-12'),
        consentStatus: 'CONFIRMED',
      }),
    ).toEqual({ ok: true });
  });

  it('weist den ausdrücklich altrechtlichen Streitmarker im Neurecht zurück', () => {
    expect(
      validate({
        issuedAt: date('2026-03-09'),
        provisionDate: date('2026-03-10'),
        notificationDate: null,
        notificationStatus: 'FAILED',
        notificationDisputedOrLate: true,
        consentStatus: 'CONFIRMED',
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('nur im Altrecht') });
  });

  it('verlangt ab 2027 einen Zugangstag nur für den wirksamen Postantrag', () => {
    const basis = {
      today: date('2027-08-23'),
      issuedAt: date('2027-03-09'),
      provisionDate: date('2027-03-10'),
      notificationDate: null,
      notificationStatus: 'NOT_RECORDED' as const,
      eligibility2027Status: 'CONFIRMED' as const,
      postalRequestStatus: 'EFFECTIVE' as const,
    };
    expect(validate(basis)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Zugangstag'),
    });
    expect(validate({ ...basis, postalRequestReceivedAt: date('2027-03-11') })).toEqual({
      ok: true,
    });
    expect(
      validate({
        ...basis,
        postalRequestStatus: 'NONE_EFFECTIVE',
        postalRequestReceivedAt: date('2027-03-11'),
      }),
    ).toMatchObject({ ok: false });
  });

  it('weist Abrufangaben bei anderen Bekanntgabewegen zurück', () => {
    expect(validate({ deliveryMethod: 'POST' })).toMatchObject({ ok: false });
  });
});
