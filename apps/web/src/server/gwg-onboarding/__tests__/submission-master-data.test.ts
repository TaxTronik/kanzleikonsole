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

    const { vatId: _taxOnly, ...gwgCurrent } = current;
    expect(change.before).toEqual(gwgCurrent);
    expect(change.after).toEqual({
      name: 'Neue GmbH',
      street: 'Altweg 1',
      postalCode: '10115',
      city: 'Hamburg',
      countryIso: 'DE',
    });
    expect(change.changedFields).toEqual(['name', 'city']);
    expect(change.after).not.toHaveProperty('vatId');
  });

  it('does not report unchanged normalized values', () => {
    const change = buildOnboardingClientMasterChange(current, {
      companyName: ' Muster GmbH ',
      street: 'Altweg 1',
      postalCode: '10115',
      city: 'Berlin',
      countryIso: 'DE',
      vatId: ' DE999999999 ',
    });

    expect(change.changedFields).toEqual([]);
    // GWG-REVERIFICATION-VALIDITY-001: stale onboarding input cannot overwrite tax data.
    expect(change.after).not.toHaveProperty('vatId');
  });
});
