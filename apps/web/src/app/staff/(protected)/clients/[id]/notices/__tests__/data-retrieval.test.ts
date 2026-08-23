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
    expect(validate({ notificationDisputedOrLate: true })).toMatchObject({
      ok: true,
      notificationDisputedOrLate: true,
      retrievedAt: null,
    });
    expect(
      validate({ notificationDisputedOrLate: true, retrievedAt: date('2025-12-29') }),
    ).toMatchObject({ ok: true, notificationDisputedOrLate: true });
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
      }),
    ).toMatchObject({ ok: true, notificationDate: null });
    expect(
      validate({
        issuedAt: date('2026-01-01'),
        provisionDate: date('2026-01-02'),
        notificationDate: date('2026-01-03'),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Bereitstellung + 4 Tage') });
  });

  it('weist Abrufangaben bei anderen Bekanntgabewegen zurück', () => {
    expect(validate({ deliveryMethod: 'POST' })).toMatchObject({ ok: false });
  });
});
