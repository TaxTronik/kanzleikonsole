import { describe, expect, it } from 'vitest';

import { buildOnboardingClientMasterChange } from '../submission-master-data';

const current = {
  name: 'Muster GmbH',
  street: 'Altweg 1',
  postalCode: '10115',
  city: 'Berlin',
  countryIso: 'DE',
  vatId: 'DE123',
};

describe('buildOnboardingClientMasterChange', () => {
  it('normalizes submitted values and reports the stable audit field order', () => {
    const change = buildOnboardingClientMasterChange(current, {
      companyName: '  Neue GmbH ',
      street: ' Altweg 1 ',
      postalCode: '10115',
      city: ' Hamburg ',
      countryIso: ' DE ',
      vatId: '   ',
    });

    expect(change.before).toEqual(current);
    expect(change.after).toEqual({
      name: 'Neue GmbH',
      street: 'Altweg 1',
      postalCode: '10115',
      city: 'Hamburg',
      countryIso: 'DE',
      vatId: null,
    });
    expect(change.changedFields).toEqual(['name', 'city', 'vatId']);
  });

  it('does not report unchanged normalized values', () => {
    const change = buildOnboardingClientMasterChange(current, {
      companyName: ' Muster GmbH ',
      street: 'Altweg 1',
      postalCode: '10115',
      city: 'Berlin',
      countryIso: 'DE',
      vatId: ' DE123 ',
    });

    expect(change.changedFields).toEqual([]);
  });
});
